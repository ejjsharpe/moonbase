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
import type { Rpc } from 'effect/rpc';
import {
  ConnectionError,
  HostVerificationError,
  LocalDaemonError,
} from '@moonbase/contracts/connection-errors';
import { InvalidChatRequestError } from '@moonbase/contracts/chat-errors';
import { CancelledError, UncertainError } from '@moonbase/contracts/errors';
import {
  HostUnavailableError,
  IncompatibleHostError,
  type DaemonLinkError,
} from '@moonbase/contracts/host-errors';
import type { ChatHostHealth, ChatHostTarget } from '@moonbase/contracts/host';
import { rpcLimits } from '@moonbase/contracts/rpc-upgrade';
import { ConnectionService, type VerifiedChatEndpoint } from '@moonbase/contracts/services';
import * as P from './protocol.ts';
import { reconnectSchedule } from './reconnect-schedule.ts';
import {
  openRpcConnection,
  type RpcConnection,
  type RpcSocketConfiguration,
} from './rpc-connection.ts';

/** What a watch delivers: a value (`reset` when it replaced missed updates) or a gap. */
export type WatchUpdate<A> = { value: A; reset: boolean } | { reconnecting: true };
export type ErrorClass = abstract new (...args: never) => unknown;

/** One socket of a host's daemon, as a link reaches it. */
export type RpcLinkConfiguration<Rpcs extends Rpc.Any> = RpcSocketConfiguration<Rpcs> & {
  host: ChatHostTarget;
  /** The errors the group's procedures declare: the only failures the client takes from it. */
  errors: readonly ErrorClass[];
  /**
   * A declared error as the client shows it (D11): its own text, none of the host's; `payload`
   * is what the client sent, from which it may rebuild a field.
   */
  present(error: unknown, operation: string, payload: object): unknown;
};
export type CallOptions<A> = {
  mutation: boolean;
  capability: string;
  /** How long to wait for the reply; `requestDeadlineMs` by default. */
  deadlineMs?: number;
  /**
   * What the request holds before it is sent (a place, its bytes), waiting up to its deadline for
   * all of it (refused `HostUnavailableError` `busy`, never sent, past it). It keeps them until
   * the daemon has answered or the connection closed, even after its caller gave up on it.
   */
  places?: readonly Hold[];
  /** Refuses a reply against the daemon's signed health. */
  check?: (output: A, health: ChatHostHealth) => void;
};
export type FollowOptions<A> = {
  capability: string;
  /**
   * The value a watch update describes, given the value before it on this subscription (none for
   * its first): it decodes and checks the update, and throws to refuse it.
   */
  next(previous: A | undefined, update: unknown): A;
};

const isOneOf = (errors: readonly ErrorClass[], error: unknown) => {
  try {
    return errors.some((member) => error instanceof member);
  } catch {
    // A value whose prototype can't be read is no error of ours.
    return false;
  }
};
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
/** Whether a failure came from the transport rather than the daemon. */
const isTransport = (error: unknown) => {
  const tag = typeof error === 'object' && error !== null && (error as { _tag?: unknown })._tag;
  return tag === 'RpcClientError' || tag === 'SocketError' || tag === 'SubscriptionLost';
};
/** A reply or update the client refused: its own refusal, else the daemon's reply was invalid. */
const refusedReply = (error: unknown, reason: 'invalid-reply' | 'invalid-update') =>
  error instanceof IncompatibleHostError || error instanceof InvalidChatRequestError
    ? error
    : new IncompatibleHostError({ reason });

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
const holdPlace = <A, E>(
  holds: readonly Hold[],
  deadlineMs: number,
  mutation: boolean,
  connection: { scope: Scope.Scope; isOpen: Effect.Effect<boolean> },
  send: Effect.Effect<A, E>,
  late: E,
  unsent: E,
) =>
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
      // A send stopped by its connection closing lost its reply.
      return yield* Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
        ? Effect.fail(late)
        : exit;
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
export const makeRpcLink = <Rpcs extends Rpc.Any>(config: RpcLinkConfiguration<Rpcs>) =>
  Effect.gen(function* () {
    const connections = yield* ConnectionService;
    const host = config.host;
    const lookUpEndpoint = connections.endpoint({ host });
    const linkErrors = [
      ...config.errors,
      ConnectionError,
      HostVerificationError,
      LocalDaemonError,
      CancelledError,
    ];
    /** Whether a failure is the daemon's (as presented) or the link's own, rather than unknown. */
    const isLinkError = (error: unknown): error is DaemonLinkError => isOneOf(linkErrors, error);
    const linkScope = yield* Effect.scope;
    const sockets: RcMap.RcMap<Generation, RpcConnection> = yield* RcMap.make({
      lookup: (generation: Generation): Effect.Effect<RpcConnection, never, Scope.Scope> =>
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

    /** Sends one request; it fails with the errors its procedure declares, or the link's own. */
    const call = <A, E>(
      operation: string,
      payload: object,
      options: CallOptions<A>,
    ): Effect.Effect<A, E | DaemonLinkError> =>
      Effect.gen(function* () {
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
        const late = lostReply(options.mutation, operation),
          unsent = unavailable('busy');
        const send = (
          connection.client[operation] as (payload: object) => Effect.Effect<unknown, unknown>
        )(payload);
        const exit = yield* Effect.exit(
          options.places
            ? holdPlace(
                options.places,
                deadlineMs,
                options.mutation,
                { scope: linkScope, isOpen: connection.isOpen },
                send,
                late,
                unsent,
              )
            : send.pipe(
                Effect.timeoutOrElse({
                  duration: deadlineMs,
                  orElse: () => Effect.fail(late),
                }),
              ),
        );
        if (Exit.isFailure(exit)) {
          // The caller's own interruption never reaches here: an interrupted reply is the
          // daemon's, as a closing RPC server sends each request it runs (#404). Its reply is lost.
          if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.fail(late);
          const error = Cause.squash(exit.cause);
          if (error === late) return yield* Effect.fail(late);
          // Refused before it was sent, whatever became of the connection since.
          if (error === unsent) return yield* Effect.fail(unsent);
          // Only an error the daemon's procedures declare is its answer; anything else lost it.
          if (isTransport(error) || !isOneOf(config.errors, error))
            return yield* Effect.fail(lostReply(options.mutation, operation));
        }
        // A reply belongs to the generation it was sent on; one that changed since is stale.
        if (!(yield* isCurrent(endpoint)))
          return yield* Effect.fail(generationChanged(options.mutation, operation));
        if (Exit.isFailure(exit))
          return yield* Effect.fail(
            config.present(Cause.squash(exit.cause), operation, payload) as E,
          );
        const output = exit.value as A;
        yield* Effect.try({
          try: () => options.check?.(output, health),
          catch: (error) =>
            options.mutation
              ? lostReply(true, operation)
              : (refusedReply(error, 'invalid-reply') as E | IncompatibleHostError),
        });
        return output;
      });

    /**
     * Follows a watch: each update turned into the value it describes by `next`. When its
     * connection drops, or the daemon ends it interrupted, it subscribes again on
     * `reconnectSchedule` once the connection has reopened, and starts from a fresh value; it fails
     * when the daemon ends it otherwise, the connection generation changes, the connection is
     * given up on or the schedule runs out.
     */
    const follow = <A, E>(operation: string, payload: object, options: FollowOptions<A>) =>
      Stream.callback<WatchUpdate<A>, E | DaemonLinkError>(
        (queue) =>
          Effect.gen(function* () {
            const first = yield* lookUpEndpoint;
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
            const subscribe = Effect.gen(function* () {
              const endpoint = yield* lookUpEndpoint;
              if (endpoint.connectionId !== first.connectionId)
                return yield* Effect.fail(generationChanged(false, operation));
              const connection = yield* connect(endpoint);
              const health = yield* connection.reopened;
              if (!health.capabilities.includes(options.capability))
                return yield* Effect.fail(notServed());
              let previous: A | undefined;
              let reset = yield* Ref.get(delivered);
              const updates = (
                connection.client[operation] as (payload: object) => Stream.Stream<unknown, unknown>
              )(payload).pipe(
                Stream.mapError((error) =>
                  isTransport(error) || !isOneOf(config.errors, error)
                    ? error
                    : config.present(error, operation, payload),
                ),
              );
              yield* Stream.runForEach(updates, (update) =>
                Effect.try({
                  try: () => options.next(previous, update),
                  catch: (error) =>
                    refusedReply(error, 'invalid-update') as E | IncompatibleHostError,
                }).pipe(
                  Effect.flatMap((value) => {
                    previous = value;
                    const offered = Queue.offer(queue, { value, reset });
                    reset = false;
                    return Effect.andThen(offered, Ref.set(delivered, true));
                  }),
                ),
              );
              // A watch the daemon ended by itself is unavailable.
              return yield* Effect.fail(unavailable('watch-ended'));
            }).pipe(
              Effect.scoped,
              // The watch's own interruption never reaches here, so an interrupted end is the
              // daemon's (#404), and a transport failure that died is as lost as one that failed.
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause) || isTransport(Cause.squash(cause))
                  ? Effect.fail(new SubscriptionLost())
                  : Effect.failCause(cause),
              ),
            );
            yield* subscribe.pipe(
              Effect.retry(
                reconnectSchedule({
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
                  Cause.fail(
                    ((error) => (isLinkError(error) ? error : unavailable()))(Cause.squash(cause)),
                  ),
                ),
              ),
            ),
          ),
        { bufferSize: 1, strategy: 'sliding' },
      );

    return { host, call, follow };
  });
export type RpcLink = Effect.Success<ReturnType<typeof makeRpcLink>>;
