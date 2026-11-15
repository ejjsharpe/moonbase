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
import { ConnectionError, HostVerificationError } from '@moonbase/contracts/connection-errors';
import { InvalidChatRequestError } from '@moonbase/contracts/chat-errors';
import { ApplicationError, CancelledError, UncertainError } from '@moonbase/contracts/errors';
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
import { requestUpgradeNonce } from './health.ts';
import * as P from './protocol.ts';
import { upgradeProtocols } from './upgrade-proof.ts';

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
  /** A declared error as the client shows it (D11): its own text, none of the host's. */
  present(error: unknown, operation: string): unknown;
};
export type CallOptions<A> = {
  mutation: boolean;
  capability: string;
  /** How long to wait for the reply; `requestDeadlineMs` by default. */
  deadlineMs?: number;
  /**
   * Places the request takes one of before it is sent, waiting up to its deadline (refused
   * `HostUnavailableError` `busy`, never sent, past it). It keeps it until the daemon has answered
   * or the connection closed, even after its caller gave up on it.
   */
  places?: Semaphore.Semaphore;
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

/**
 * Runs `send` holding one of `places`: it waits up to `deadlineMs` for one, then sends in a fiber
 * of the connection's `scope` that keeps the place until the daemon answers or the connection
 * closes. A caller that stops waiting (past `deadlineMs`, or interrupted) cancels a read; a
 * mutation keeps running and keeps its place.
 */
const holdPlace = <A, E>(
  places: Semaphore.Semaphore,
  deadlineMs: number,
  mutation: boolean,
  scope: Scope.Scope,
  send: Effect.Effect<A, E>,
  late: E,
) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      yield* restore(
        places.take(1).pipe(
          Effect.timeoutOrElse({
            duration: deadlineMs,
            orElse: () => Effect.fail(unavailable('busy')),
          }),
        ),
      );
      // Taken and forked in one uninterruptible step, so the place is always released.
      const fiber = yield* Effect.forkIn(send.pipe(Effect.ensuring(places.release(1))), scope);
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
      CancelledError,
      ApplicationError,
    ];
    /** Whether a failure is the daemon's (as presented) or the link's own, rather than unknown. */
    const isLinkError = (error: unknown): error is DaemonLinkError => isOneOf(linkErrors, error);
    let current: Generation | undefined;
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => (current ? Scope.close(current.scope, Exit.void) : Effect.void)),
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
          if (old) yield* Scope.close(old.scope, Exit.void);
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
        const late = lostReply(options.mutation, operation);
        const send = (
          generation.client[operation] as (payload: object) => Effect.Effect<unknown, unknown>
        )(payload);
        const exit = yield* Effect.exit(
          options.places
            ? holdPlace(options.places, deadlineMs, options.mutation, generation.scope, send, late)
            : send.pipe(
                Effect.timeoutOrElse({ duration: deadlineMs, orElse: () => Effect.fail(late) }),
              ),
        );
        if (Exit.isFailure(exit)) {
          if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt;
          const error = Cause.squash(exit.cause);
          if (error === late) return yield* Effect.fail(late);
          // Only an error the daemon's procedures declare is its answer; anything else lost it.
          if (isTransport(error) || !isOneOf(config.errors, error))
            return yield* Effect.fail(lostReply(options.mutation, operation));
        }
        // A reply belongs to the generation it was sent on; one that changed since is stale.
        if (!(yield* isCurrent(endpoint)))
          return yield* Effect.fail(generationChanged(options.mutation, operation));
        if (Exit.isFailure(exit))
          return yield* Effect.fail(config.present(Cause.squash(exit.cause), operation) as E);
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
                        : config.present(error, operation),
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
