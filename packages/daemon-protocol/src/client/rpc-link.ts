import {
  Cause,
  Clock,
  Data,
  Effect,
  Equal,
  Exit,
  Fiber,
  Hash,
  Queue,
  RcMap,
  Ref,
  Stream,
  type Scope,
  type Semaphore,
} from 'effect';
import type { Rpc, RpcGroup } from 'effect/rpc';
import type { RpcClientError } from 'effect/rpc/RpcClientError';
import {
  ConnectionError,
  HostVerificationError,
  LocalDaemonError,
} from '@moonbase/contracts/connection-errors';
import { CancelledError, UncertainError } from '@moonbase/contracts/errors';
import {
  HostUnavailableError,
  IncompatibleHostError,
  type DaemonLinkError,
} from '@moonbase/contracts/host-errors';
import type { ChatHostHealth, ChatHostTarget } from '@moonbase/contracts/host';
import { isMutationRpc } from '@moonbase/contracts/rpc-annotations';
import { rpcLimits } from '@moonbase/contracts/rpc-upgrade';
import { ConnectionService, type VerifiedChatEndpoint } from '@moonbase/contracts/services';
import { declaredErrorsOf, isOneOf, type Procedure } from '../declared-errors.ts';
import * as P from './protocol.ts';
import { reconnectSchedule } from './reconnect-schedule.ts';
import {
  openRpcConnection,
  type RpcConnection,
  type RpcConnectionClient,
  type RpcSocketConfiguration,
} from './rpc-connection.ts';

/** What a watch delivers: a value (`reset` when it replaced missed updates) or a gap. */
export type WatchUpdate<A> = { value: A; reset: boolean } | { reconnecting: true };
/** One socket of a host's daemon, as a link reaches it. */
export type RpcLinkConfiguration<Rpcs extends Rpc.Any> = RpcSocketConfiguration<Rpcs> & {
  host: ChatHostTarget;
};
/** A declared error, as the procedure's union decodes it: whatever its client fails with but the transport's. */
type Declared<E> = Exclude<E, RpcClientError>;
export type CallOptions<A, E, P, C> = {
  capability: string;
  /** How long to wait for the reply; `requestDeadlineMs` by default. */
  deadlineMs?: number;
  /**
   * What the request holds before it is sent (a place, its bytes), waiting up to its deadline for
   * all of it (refused `HostUnavailableError` `busy`, never sent, past it). It keeps them until
   * the daemon has answered or the connection closed, even after its caller gave up on it.
   */
  places?: readonly Hold[];
  /**
   * An error the procedure declares as the client shows it (D11): its own text, none of the
   * host's.
   */
  present(error: Declared<E>): P;
  /** Refuses a reply against the daemon's signed health. */
  check?: (output: A, health: ChatHostHealth) => Effect.Effect<void, C>;
};
export type FollowOptions<U, E, A, P, C> = {
  capability: string;
  /** An error the watch declares as the client shows it (D11). */
  present(error: Declared<E>): P;
  /**
   * The value a watch update describes, given the value before it on this subscription (none for
   * its first): it checks the update, and fails to refuse it.
   */
  next(previous: A | undefined, update: U): Effect.Effect<A, C>;
};
/**
 * The one method of the connection's typed client a request's tag names. The link selects it by
 * the tag and hands over only it, so the procedure a request sends is always the one whose
 * metadata (a mutation or not) the link reads, whatever the tag's static type.
 */
export type ProcedureMethod<
  Rpcs extends Rpc.Any,
  K extends Rpc.Tag<Rpcs>,
> = RpcConnectionClient<Rpcs>[K];
/**
 * A link to one socket of a host's daemon: `call` sends one request and `follow` follows a watch,
 * each through the connection's typed client.
 */
export interface RpcLink<Rpcs extends Rpc.Any> {
  readonly host: ChatHostTarget;
  /** Sends one request; it fails with the errors its procedure declares, or the link's own. */
  call<K extends Rpc.Tag<Rpcs>, A, E, P, C = never>(
    operation: K,
    send: (method: ProcedureMethod<Rpcs, K>) => Effect.Effect<A, E>,
    options: CallOptions<A, E, P, C>,
  ): Effect.Effect<A, P | C | DaemonLinkError>;
  /**
   * Follows a watch: each update turned into the value it describes by `next`. When its
   * connection drops, or the daemon ends it interrupted, it subscribes again on
   * `reconnectSchedule` once the connection has reopened, and starts from a fresh value; it fails
   * when the daemon ends it otherwise, the connection generation changes, the connection is
   * given up on or the schedule runs out.
   */
  follow<K extends Rpc.Tag<Rpcs>, U, E, A, P, C = never>(
    operation: K,
    subscribe: (method: ProcedureMethod<Rpcs, K>) => Stream.Stream<U, E>,
    options: FollowOptions<U, E, A, P, C>,
  ): Stream.Stream<WatchUpdate<A>, P | C | DaemonLinkError>;
}

/** Each procedure of a group: the errors it declares, and whether it is a mutation. */
const describeProcedures = <Rpcs extends Procedure>(group: RpcGroup.RpcGroup<Rpcs>) =>
  new Map(
    [...group.requests].map(([tag, rpc]) => [
      tag,
      { errors: declaredErrorsOf(rpc), mutation: isMutationRpc(rpc) },
    ]),
  );

const unavailable = (reason: HostUnavailableError['reason'] = 'closed') =>
  new HostUnavailableError({ reason });
/** A request whose reply never came back: a mutation may have applied. */
const lostReply = (mutation: boolean, operation: string) =>
  mutation ? new UncertainError({ operation }) : unavailable('reply-lost');
/** A request whose reply came on a generation that has since changed: a mutation may have applied. */
const generationChanged = (mutation: boolean, operation: string) =>
  mutation ? new UncertainError({ operation }) : unavailable('generation-changed');
const notServed = () => new IncompatibleHostError({ reason: 'not-served' });
/**
 * A watch's subscription its connection lost: the socket dropped, or the daemon ended it
 * interrupted, as a closing RPC server does. It is subscribed again, and never leaves the link.
 */
class SubscriptionLost extends Data.TaggedError('SubscriptionLost') {}
/** A watch's failure its own `present` or `next` gave: it leaves the link as it is. */
class Refused<E> extends Data.TaggedError('Refused')<{ error: E }> {}
/** Whether a failure came from the transport rather than the daemon. */
const isTransport = (error: unknown) => {
  const tag = typeof error === 'object' && error !== null && (error as { _tag?: unknown })._tag;
  return tag === 'RpcClientError' || tag === 'SocketError' || tag === 'SubscriptionLost';
};
/**
 * A reply or update whose check died on it, or threw before it returned one: the daemon's reply
 * was invalid.
 */
const invalidAfterDefect = <A, E>(
  check: () => Effect.Effect<A, E>,
  reason: 'invalid-reply' | 'invalid-update',
) =>
  Effect.catchDefect(Effect.suspend(check), () =>
    Effect.fail(new IncompatibleHostError({ reason })),
  );

/** A connection generation, as the link keys its connections: equal by `connectionId`. */
class Generation implements Equal.Equal {
  readonly endpoint: VerifiedChatEndpoint;
  constructor(endpoint: VerifiedChatEndpoint) {
    this.endpoint = endpoint;
  }
  [Equal.symbol](that: unknown) {
    return that instanceof Generation && that.endpoint.connectionId === this.endpoint.connectionId;
  }
  [Hash.symbol]() {
    return Hash.string(this.endpoint.connectionId);
  }
}

/** Permits of a semaphore a request holds while the daemon runs it: a place, or its bytes. */
export type Hold = { semaphore: Semaphore.Semaphore; permits: number };
/**
 * Runs `send` holding `holds`: it waits up to `deadlineMs` for all of them, one after another, then
 * sends in a fiber of the link's scope that keeps them until the daemon answers or the
 * connection closes. A caller that stops waiting (past `deadlineMs`, or interrupted) cancels a
 * read; a mutation keeps running and keeps what it holds.
 */
const holdPlace = <A, E, L>(
  holds: readonly Hold[],
  deadlineMs: number,
  mutation: boolean,
  connection: { scope: Scope.Scope; isOpen: Effect.Effect<boolean> },
  send: Effect.Effect<A, E>,
  late: L,
  unsent: L,
): Effect.Effect<A, E | L> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const until = clock.currentTimeMillisUnsafe() + deadlineMs;
      const release = (taken: readonly Hold[]) =>
        Effect.forEach(taken, ({ semaphore, permits }) => semaphore.release(permits), {
          discard: true,
        });
      // Each is taken in an interruptible wait, and recorded as held before anything else runs.
      const taken: Hold[] = [];
      for (const hold of holds) {
        const left = Math.max(0, until - clock.currentTimeMillisUnsafe());
        yield* restore(
          hold.semaphore.take(hold.permits).pipe(
            Effect.timeoutOrElse({
              duration: left,
              orElse: () => Effect.fail(unsent),
            }),
          ),
        ).pipe(Effect.onError(() => release(taken)));
        taken.push(hold);
      }
      // A connection that closed while the request waited carries nothing more: it was never sent.
      if (!(yield* connection.isOpen)) {
        yield* release(taken);
        return yield* Effect.fail(unsent);
      }
      // Taken and forked in one uninterruptible step, so the place is always released.
      // In the link's scope, which outlives connections: the send ends when its connection closes
      // (the RPC client interrupts what it carried), so what it holds is always released.
      const fiber = yield* Effect.forkIn(
        send.pipe(Effect.ensuring(release(taken))),
        connection.scope,
      );
      // A read its caller stops waiting for is cancelled: asked at once, not awaited, so its
      // place frees once the daemon was told. A mutation keeps running.
      const abandon = Effect.sync(() => {
        if (!mutation) fiber.interruptUnsafe();
      });
      const exit = yield* restore(
        Fiber.await(fiber).pipe(
          Effect.timeoutOrElse({
            duration: deadlineMs,
            orElse: () => Effect.andThen(abandon, Effect.fail(late)),
          }),
        ),
      ).pipe(Effect.onInterrupt(() => abandon));
      // A send stopped by its connection closing ends interrupted, as `call` reads it.
      return yield* exit;
    }),
  );

/**
 * A link to one socket of a host's daemon, shared by the services built with it: one connection
 * per connection generation, opened on first use and reopened by the RPC client when it drops,
 * each time with a fresh upgrade proof. An older generation's connection closes once nothing uses
 * it, and one given up on is replaced on next use. A request is sent once: one whose connection
 * drops, whose reply is late or arrives after the generation changed is `Unavailable`, or
 * `Uncertain` for a mutation.
 */
export const makeRpcLink = <Rpcs extends Procedure>(
  config: RpcLinkConfiguration<Rpcs>,
): Effect.Effect<RpcLink<Rpcs>, never, ConnectionService | Scope.Scope> =>
  Effect.gen(function* () {
    const connections = yield* ConnectionService;
    const host = config.host;
    const lookUpEndpoint = connections.endpoint({ host });
    const procedures = describeProcedures(config.group);
    const describe = (operation: string) => procedures.get(operation)!;
    const linkErrors = [
      ...new Set([...procedures.values()].flatMap((procedure) => procedure.errors)),
      ConnectionError,
      HostVerificationError,
      LocalDaemonError,
      CancelledError,
    ];
    /** Whether a failure is the daemon's (as presented) or the link's own, rather than unknown. */
    const isLinkError = (error: unknown): error is DaemonLinkError => isOneOf(linkErrors, error);
    const linkScope = yield* Effect.scope;
    const sockets: RcMap.RcMap<Generation, RpcConnection<Rpcs>> = yield* RcMap.make({
      lookup: (generation: Generation): Effect.Effect<RpcConnection<Rpcs>, never, Scope.Scope> =>
        openRpcConnection(
          config,
          generation.endpoint,
          isLinkError,
          // Given up on, it closes and is replaced on next use: out of the map before anything
          // else runs, then closed in the link's scope, since closing it waits for its retry.
          Effect.asVoid(
            Effect.forkIn(RcMap.invalidate(sockets, generation), linkScope, {
              startImmediately: true,
            }),
          ),
        ),
      idleTimeToLive: Infinity,
    });
    /**
     * The connection for `endpoint`'s generation, opened once however many ask at once; an older
     * generation's closes, failing what it still carries. None is held by its users, so it stays
     * open until then (or until given up on), between requests too.
     */
    const connect = (endpoint: VerifiedChatEndpoint) =>
      Effect.gen(function* () {
        const generation = new Generation(endpoint);
        for (const key of yield* RcMap.keys(sockets))
          if (!Equal.equals(key, generation)) yield* RcMap.invalidate(sockets, key);
        return yield* Effect.scoped(RcMap.get(sockets, generation));
      });
    const isCurrent = (endpoint: VerifiedChatEndpoint) =>
      Effect.map(Effect.exit(lookUpEndpoint), (now) =>
        Exit.isSuccess(now) ? now.value.connectionId === endpoint.connectionId : false,
      );

    const call: RpcLink<Rpcs>['call'] = (operation, send, options) =>
      Effect.gen(function* () {
        const { errors, mutation } = describe(operation);
        const endpoint = yield* lookUpEndpoint;
        const connection = yield* connect(endpoint);
        const health = yield* connection.ready.pipe(
          Effect.timeoutOrElse({
            duration: rpcLimits.connectMs,
            orElse: () => Effect.fail(unavailable('unreachable')),
          }),
        );
        if (!health.capabilities.includes(options.capability))
          return yield* Effect.fail(notServed());
        const deadlineMs = options.deadlineMs ?? P.requestDeadlineMs;
        const late = lostReply(mutation, operation),
          unsent = unavailable('busy');
        const sent = Effect.suspend(() => send(connection.client[operation]));
        const exit = yield* Effect.exit(
          options.places
            ? holdPlace(
                options.places,
                deadlineMs,
                mutation,
                { scope: linkScope, isOpen: connection.isOpen },
                sent,
                late,
                unsent,
              )
            : sent.pipe(
                Effect.timeoutOrElse({
                  duration: deadlineMs,
                  orElse: () => Effect.fail(late),
                }),
              ),
        );
        if (Exit.isFailure(exit)) {
          // The caller's own interruption never reaches here: an interrupted reply is the
          // daemon's, as a closing RPC server sends each request it runs (#404), or its
          // connection's as it closes.
          const interrupted = Cause.hasInterruptsOnly(exit.cause);
          const error = interrupted ? undefined : Cause.squash(exit.cause);
          if (error === late) return yield* Effect.fail(late);
          // Refused before it was sent, whatever became of the connection since.
          if (error === unsent) return yield* Effect.fail(unsent);
          // Only an error the procedure declares is the daemon's answer; anything else lost it,
          // to a generation change if there was one.
          if (interrupted || isTransport(error) || !isOneOf(errors, error))
            return yield* Effect.fail(
              (yield* isCurrent(endpoint))
                ? lostReply(mutation, operation)
                : generationChanged(mutation, operation),
            );
        }
        // A reply belongs to the generation it was sent on; one that changed since is stale.
        if (!(yield* isCurrent(endpoint)))
          return yield* Effect.fail(generationChanged(mutation, operation));
        if (Exit.isFailure(exit))
          // A failure of the procedure's declared union, as the check above found.
          return yield* Effect.fail(
            options.present(Cause.squash(exit.cause) as Parameters<typeof options.present>[0]),
          );
        const output = exit.value;
        if (options.check)
          yield* invalidAfterDefect(() => options.check!(output, health), 'invalid-reply').pipe(
            // A mutation's reply refused: it may have applied.
            Effect.mapError((error) => (mutation ? lostReply(true, operation) : error)),
          );
        return output;
      });

    /** What a watch fails with: its own refusal as it gave it, the link's own, or unavailable. */
    const leaving = <R>(error: unknown): R | DaemonLinkError => {
      if (error instanceof Refused) return error.error as R;
      return isLinkError(error) ? error : unavailable();
    };
    const follow = <K extends Rpc.Tag<Rpcs>, U, E, A, P, C>(
      operation: K,
      subscribe: (method: ProcedureMethod<Rpcs, K>) => Stream.Stream<U, E>,
      options: FollowOptions<U, E, A, P, C>,
    ) =>
      Stream.callback<WatchUpdate<A>, P | C | DaemonLinkError>(
        (queue) =>
          Effect.gen(function* () {
            const first = yield* lookUpEndpoint;
            const clock = yield* Clock.Clock;
            // A connection publication ends the watch once its generation is gone.
            yield* Effect.forkScoped(
              connections.watch().pipe(
                Stream.runForEach(() =>
                  Effect.flatMap(isCurrent(first), (same) =>
                    same
                      ? Effect.void
                      : Effect.asVoid(
                          Queue.failCause(queue, Cause.fail(generationChanged(false, operation))),
                        ),
                  ),
                ),
                Effect.ignore,
              ),
            );
            // Once a value has been delivered, a lost subscription reads as reconnecting and the
            // first value after it replaces whatever was missed.
            const delivered = yield* Ref.make(false);
            // When this subscription delivered its first value: one that had been delivering for
            // `renewMs` renews the reconnect budget.
            const firstAt = yield* Ref.make<number | undefined>(undefined);
            const { errors } = describe(operation);
            const resubscribe = Effect.gen(function* () {
              yield* Ref.set(firstAt, undefined);
              const endpoint = yield* lookUpEndpoint;
              if (endpoint.connectionId !== first.connectionId)
                return yield* Effect.fail(generationChanged(false, operation));
              const connection = yield* connect(endpoint);
              const health = yield* connection.reopened;
              if (!health.capabilities.includes(options.capability))
                return yield* Effect.fail(notServed());
              let previous: A | undefined;
              let reset = yield* Ref.get(delivered);
              const updates = subscribe(connection.client[operation]).pipe(
                Stream.mapError((error) =>
                  isTransport(error) || !isOneOf(errors, error)
                    ? error
                    : new Refused({
                        error: options.present(error as Parameters<typeof options.present>[0]),
                      }),
                ),
              );
              yield* Stream.runForEach(updates, (update) =>
                invalidAfterDefect(() => options.next(previous, update), 'invalid-update').pipe(
                  Effect.mapError((error) => new Refused({ error })),
                  Effect.flatMap((value) => {
                    previous = value;
                    const offered = Queue.offer(queue, { value, reset });
                    reset = false;
                    return offered.pipe(
                      Effect.andThen(Ref.set(delivered, true)),
                      Effect.andThen(
                        Ref.update(firstAt, (at) => at ?? clock.currentTimeMillisUnsafe()),
                      ),
                    );
                  }),
                ),
              );
              // A watch the daemon ended by itself is unavailable.
              return yield* Effect.fail(unavailable('watch-ended'));
            }).pipe(
              Effect.scoped,
              // The watch's own interruption never reaches here, so an interrupted end is the
              // daemon's (#404), and a transport failure that died is as lost as one that failed.
              Effect.catchCauseIf(
                (cause) => Cause.hasInterruptsOnly(cause) || isTransport(Cause.squash(cause)),
                () => Effect.fail(new SubscriptionLost()),
              ),
            );
            yield* resubscribe.pipe(
              Effect.retry(
                reconnectSchedule({
                  upSince: Ref.get(firstAt),
                  isRetryable: isTransport,
                  onRetry: () =>
                    Effect.flatMap(Ref.get(delivered), (gap) =>
                      gap ? Effect.asVoid(Queue.offer(queue, { reconnecting: true })) : Effect.void,
                    ),
                }),
              ),
            );
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.asVoid(
                Queue.failCause(
                  queue,
                  Cause.fail(leaving<P | C | IncompatibleHostError>(Cause.squash(cause))),
                ),
              ),
            ),
          ),
        { bufferSize: 1, strategy: 'sliding' },
      );

    return { host, call, follow };
  });
