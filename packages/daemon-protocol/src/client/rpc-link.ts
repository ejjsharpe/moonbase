import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Schedule,
  Scope,
  Semaphore,
  Stream,
} from 'effect';
import { RpcClient, RpcSerialization, type Rpc, type RpcGroup } from 'effect/rpc';
import * as Socket from 'effect/socket/Socket';
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
import {
  chatHostCapabilities,
  type ChatHostHealth,
  type ChatHostTarget,
} from '@moonbase/contracts/host';
import { rpcLimits } from '@moonbase/contracts/rpc-upgrade';
import { ConnectionService, type VerifiedChatEndpoint } from '@moonbase/contracts/services';
import { requestUpgradeNonce } from '../health.ts';
import * as P from './protocol.ts';
import { upgradeProtocols } from '../upgrade-proof.ts';

/** What a watch delivers: a value (`reset` when it replaced missed updates) or a gap. */
export type WatchUpdate<A> = { value: A; reset: boolean } | { reconnecting: true };
export type ErrorClass = abstract new (...args: never) => unknown;
/** One connection to a daemon's socket, and the health it signed when it was opened. */
type Generation = {
  connectionId: string;
  client: Record<string, unknown>;
  health: ChatHostHealth;
  scope: Scope.Closeable;
  alive: boolean;
};

/** One socket of a host's daemon, as a link reaches it. */
export type RpcLinkConfiguration<Rpcs extends Rpc.Any> = {
  host: ChatHostTarget;
  group: RpcGroup.RpcGroup<Rpcs>;
  /** Where the socket upgrades, and the protocol a proof for it binds. */
  path: string;
  protocol: string;
  /** What signed health advertises for this socket; a host without it is refused unsent. */
  capability?: string;
  /** The largest message the client accepts from the daemon (D11). */
  inboundBytes: number;
  /** How long the client waits for any message before it drops the connection; 5 s by default. */
  pingTimeoutMs?: number;
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
/** Whether a failure came from the transport rather than the daemon. */
const isTransport = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  (error as { _tag?: string })._tag === 'RpcClientError';
/** A reply or update the client refused: its own refusal, else the daemon's reply was invalid. */
const refusedReply = (error: unknown, reason: 'invalid-reply' | 'invalid-update') =>
  error instanceof IncompatibleHostError || error instanceof InvalidChatRequestError
    ? error
    : new IncompatibleHostError({ reason });

/**
 * A daemon's WebSocket bounded inbound (D11): a message over `bytes` closes it before anything
 * reads it.
 */
function boundInbound(ws: WebSocket, bytes: number): Socket.WebSocketLike {
  const wrapped = new Map<unknown, (event: Socket.WebSocketEvent) => void>();
  return {
    get readyState() {
      return ws.readyState;
    },
    get binaryType() {
      return ws.binaryType;
    },
    set binaryType(value: WebSocket['binaryType']) {
      ws.binaryType = value;
    },
    addEventListener(type, listener, options) {
      if (type !== 'message') return ws.addEventListener(type, listener as never, options);
      const bounded = (event: Socket.WebSocketEvent) => {
        const data = event.data as string | ArrayBuffer | Uint8Array;
        const size = typeof data === 'string' ? data.length : data.byteLength;
        if (size > bytes) return ws.close(1009);
        listener(event);
      };
      wrapped.set(listener, bounded);
      ws.addEventListener('message', bounded as never, options);
    },
    removeEventListener(type, listener) {
      ws.removeEventListener(type, (wrapped.get(listener) ?? listener) as never);
      wrapped.delete(listener);
    },
    close: (code, reason) => ws.close(code, reason),
    send: (data) => ws.send(data),
  } as Socket.WebSocketLike;
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
  connection: { scope: Scope.Scope; isOpen(): boolean },
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
      if (!connection.isOpen()) {
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
 * per connection generation, opened on first use with a fresh upgrade proof and again after it
 * closes. A request is sent once: one whose connection drops, whose reply is late or arrives
 * after the generation changed is `Unavailable`, or `Uncertain` for a mutation.
 */
export const makeRpcLink = <Rpcs extends Rpc.Any>(config: RpcLinkConfiguration<Rpcs>) =>
  Effect.gen(function* () {
    const connections = yield* ConnectionService;
    const host = config.host;
    const lookUpEndpoint = connections.endpoint({ host });
    const lock = yield* Semaphore.make(1);
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
    let current: Generation | undefined;
    /** Closes a generation's connection, marking it gone first, so nothing waiting sends on it. */
    const closeGeneration = (generation: Generation) =>
      Effect.suspend(() => {
        generation.alive = false;
        return Scope.close(generation.scope, Exit.void);
      });
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => (current ? closeGeneration(current) : Effect.void)),
    );

    /** Opens a connection to `endpoint` and waits until it is upgraded. */
    const open = (endpoint: VerifiedChatEndpoint) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const opened = Deferred.makeUnsafe<ChatHostHealth, DaemonLinkError>();
        const generation = {
          connectionId: endpoint.connectionId,
          scope,
          alive: true,
        } as Generation;
        const acquire = Effect.gen(function* () {
          const { health, upgradeNonce } = yield* requestUpgradeNonce(endpoint);
          if (!health.capabilities.includes(chatHostCapabilities.rpc))
            return yield* Effect.fail(new IncompatibleHostError({ reason: 'not-daemon' }));
          if (config.capability !== undefined && !health.capabilities.includes(config.capability))
            return yield* Effect.fail(notServed());
          const url = new URL(config.path, endpoint.origin.replace(/^http:/, 'ws:'));
          // The connection closes with the scope that acquired it.
          const ws = yield* Effect.acquireRelease(
            Effect.sync(
              () =>
                new globalThis.WebSocket(
                  url,
                  upgradeProtocols(
                    endpoint.token,
                    upgradeNonce,
                    endpoint.expected,
                    config.protocol,
                  ),
                ),
            ),
            (ws) => Effect.sync(() => ws.close()),
          );
          ws.addEventListener('open', () => Deferred.doneUnsafe(opened, Exit.succeed(health)), {
            once: true,
          });
          ws.addEventListener(
            'close',
            () => Deferred.doneUnsafe(opened, Exit.fail(unavailable('refused'))),
            { once: true },
          );
          return boundInbound(ws, config.inboundBytes);
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() =>
              Deferred.doneUnsafe(
                opened,
                Exit.fail(isLinkError(error) ? error : unavailable('unreachable')),
              ),
            ),
          ),
          Effect.mapError(
            (cause) =>
              new Socket.SocketError({
                reason: new Socket.SocketOpenError({ kind: 'Unknown', cause }),
              }),
          ),
        );
        const transport = RpcClient.layerProtocolSocket({
          retryPolicy: Schedule.recurs(0),
          ...(config.pingTimeoutMs === undefined ? {} : { pingTimeout: config.pingTimeoutMs }),
        }).pipe(
          Layer.provide([
            Layer.effect(
              Socket.Socket,
              Socket.fromWebSocket(acquire, { openTimeout: rpcLimits.connectMs }),
            ),
            RpcSerialization.layerJson,
            Layer.succeed(RpcClient.ConnectionHooks, {
              onConnect: Effect.void,
              onDisconnect: Effect.sync(() => {
                generation.alive = false;
              }),
            }),
          ]),
        );
        const context = yield* Layer.buildWithScope(transport, scope);
        const client = yield* RpcClient.make(config.group, { disableTracing: true }).pipe(
          Effect.provideContext(context),
          Scope.provide(scope),
        );
        const health = yield* Deferred.await(opened).pipe(
          Effect.timeoutOrElse({
            duration: rpcLimits.connectMs,
            orElse: () => Effect.fail(unavailable('unreachable')),
          }),
          Effect.tapError(() => Scope.close(scope, Exit.void)),
        );
        return Object.assign(generation, { client: client as never, health });
      });
    /** The open connection for `endpoint`'s generation, or a new one; an older one closes. */
    const connect = (endpoint: VerifiedChatEndpoint) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (current?.alive && current.connectionId === endpoint.connectionId) return current;
          const old = current;
          current = undefined;
          if (old) yield* closeGeneration(old);
          const opened = yield* open(endpoint);
          current = opened;
          return opened;
        }),
      );
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
        const generation = yield* connect(endpoint);
        if (!generation.health.capabilities.includes(options.capability))
          return yield* Effect.fail(notServed());
        const deadlineMs = options.deadlineMs ?? P.requestDeadlineMs;
        const late = lostReply(options.mutation, operation),
          unsent = unavailable('busy');
        const send = (
          generation.client[operation] as (payload: object) => Effect.Effect<unknown, unknown>
        )(payload);
        const exit = yield* Effect.exit(
          options.places
            ? holdPlace(
                options.places,
                deadlineMs,
                options.mutation,
                { scope: linkScope, isOpen: () => generation.alive },
                send,
                late,
                unsent,
              )
            : send.pipe(
                Effect.timeoutOrElse({ duration: deadlineMs, orElse: () => Effect.fail(late) }),
              ),
        );
        if (Exit.isFailure(exit)) {
          if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt;
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
          try: () => options.check?.(output, generation.health),
          catch: (error) =>
            options.mutation
              ? lostReply(true, operation)
              : (refusedReply(error, 'invalid-reply') as E | IncompatibleHostError),
        });
        return output;
      });

    /**
     * Follows a watch: each update turned into the value it describes by `next`. When its
     * connection drops it subscribes again within a budget of `streamLimits.reconnectMs` per
     * outage, renewed once a connection has carried values for `streamLimits.renewMs`, and starts
     * from a fresh value; it fails when the daemon ends it, the connection generation changes or
     * the budget runs out.
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
            // Backoff and the healthy period that renews it run on the fiber's Clock.
            const clock = yield* Clock.Clock;
            let delivered = false,
              failures = 0;
            for (;;) {
              let firstAt: number | undefined;
              // The first value after subscribing again replaced whatever was missed.
              let resetting = delivered;
              const ended = yield* Effect.exit(
                Effect.gen(function* () {
                  const endpoint = yield* lookUpEndpoint;
                  if (endpoint.connectionId !== first.connectionId)
                    return yield* Effect.fail(generationChanged(false, operation));
                  const generation = yield* connect(endpoint);
                  if (!generation.health.capabilities.includes(options.capability))
                    return yield* Effect.fail(notServed());
                  let state: A | undefined;
                  const updates = (
                    generation.client[operation] as (
                      payload: object,
                    ) => Stream.Stream<unknown, unknown>
                  )(payload).pipe(
                    Stream.mapError((error) =>
                      isTransport(error) || !isOneOf(config.errors, error)
                        ? error
                        : config.present(error, operation, payload),
                    ),
                  );
                  yield* Stream.runForEach(updates, (update) =>
                    Effect.try({
                      try: () => {
                        const value = options.next(state, update);
                        state = value;
                        firstAt ??= clock.currentTimeMillisUnsafe();
                        Queue.offerUnsafe(queue, { value, reset: resetting });
                        resetting = false;
                        delivered = true;
                      },
                      catch: (error) =>
                        refusedReply(error, 'invalid-update') as E | IncompatibleHostError,
                    }),
                  );
                  // A watch the daemon ended by itself is unavailable.
                  return yield* Effect.fail(unavailable('watch-ended'));
                }),
              );
              if (Exit.isSuccess(ended)) return;
              if (Cause.hasInterruptsOnly(ended.cause)) return yield* ended;
              const error = Cause.squash(ended.cause);
              if (!isTransport(error))
                return yield* Effect.fail(isLinkError(error) ? error : unavailable());
              if (
                firstAt !== undefined &&
                clock.currentTimeMillisUnsafe() - firstAt >= P.streamLimits.renewMs
              )
                failures = 0;
              if (failures >= P.streamLimits.reconnectMs.length)
                return yield* Effect.fail(unavailable());
              if (delivered) Queue.offerUnsafe(queue, { reconnecting: true });
              yield* Effect.sleep(P.streamLimits.reconnectMs[failures++]!);
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.asVoid(
                    Queue.failCause(
                      queue,
                      Cause.fail(
                        ((error) => (isLinkError(error) ? error : unavailable()))(
                          Cause.squash(cause),
                        ),
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
