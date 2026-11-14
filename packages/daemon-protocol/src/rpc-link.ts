import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Queue,
  Schedule,
  Scope,
  Semaphore,
  Stream,
} from 'effect';
import { RpcClient, RpcSerialization } from 'effect/rpc';
import * as Socket from 'effect/socket/Socket';
import { ChatRpcs, chatRpcErrors } from '@moonbase/contracts/chat-rpc';
import {
  LocalHostRpcs,
  ProviderSetupRpcs,
  localHostRpcErrors,
  providerSetupRpcErrors,
} from '@moonbase/contracts/daemon-rpc';
import { ConnectionError, HostVerificationError } from '@moonbase/contracts/connection-errors';
import { InvalidChatRequestError } from '@moonbase/contracts/chat-errors';
import {
  ApplicationError,
  CancelledError,
  UnauthorizedError,
  UncertainError,
} from '@moonbase/contracts/errors';
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
import { rpcLimits, rpcPath } from '@moonbase/contracts/rpc-upgrade';
import { ConnectionService, type VerifiedChatEndpoint } from '@moonbase/contracts/services';
import {
  applySocketDelta,
  socketLimits,
  type SocketDelta,
  type SocketSubscriptionKind,
  type SocketSubscriptionValue,
} from '@moonbase/contracts/socket';
import { decodeSocketSubscriptionValue } from '@moonbase/contracts/socket-schema';
import { requestUpgradeNonce } from './health.ts';
import * as P from './protocol.ts';
import { upgradeProtocols } from './upgrade-proof.ts';

/** Every procedure a daemon may serve over RPC. */
export const DaemonRpcs = ChatRpcs.merge(LocalHostRpcs, ProviderSetupRpcs);
type Client = RpcClient.FromGroup<typeof DaemonRpcs>;
/** What a watch delivers: a value (`reset` when it replaced missed updates) or a gap. */
export type WatchUpdate<A> = { value: A; reset: boolean } | { reconnecting: true };
/** One RPC connection to a daemon process, and the health it signed when it was opened. */
type Generation = {
  connectionId: string;
  client: Client;
  health: ChatHostHealth;
  scope: Scope.Closeable;
  alive: boolean;
};

/** The errors a daemon's procedures declare: the only failures a client takes from it. */
const remoteErrors = [
  ...new Set([...chatRpcErrors, ...localHostRpcErrors, ...providerSetupRpcErrors]),
];
/** What a service over the link fails with: a daemon's errors as presented, or the link's own. */
export type RemoteError = InstanceType<(typeof remoteErrors)[number]>;
const isOneOf = (errors: readonly (abstract new (...args: never) => unknown)[], error: unknown) => {
  try {
    return errors.some((member) => error instanceof member);
  } catch {
    // A value whose prototype can't be read is no error of ours.
    return false;
  }
};
const linkErrors = [
  ...remoteErrors,
  ConnectionError,
  HostVerificationError,
  CancelledError,
  ApplicationError,
];
/** Whether a failure is the daemon's (as presented) or the link's own, rather than unknown. */
const isLinkError = (error: unknown): error is DaemonLinkError => isOneOf(linkErrors, error);

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
 * A daemon's own error as the client shows it (D11): its tag and literal reason, decoded into the
 * client's own classes, so its message is the client's fixed text and it carries no cause. Free
 * text a host could fill (the operation an outcome names) is the client's own, and an outcome's
 * target is dropped. A decoded number, such as a command's exit status, is kept.
 */
export function presentRemoteError(error: RemoteError, operation: string): RemoteError {
  switch (error._tag) {
    case 'UncertainError':
      return new UncertainError({ operation });
    case 'UnauthorizedError':
      return new UnauthorizedError({ operation });
    default:
      return error;
  }
}

/**
 * A daemon's WebSocket bounded inbound (D11): a message over `rpcLimits.inboundBytes` closes it
 * before anything reads it.
 */
function boundInbound(ws: WebSocket): Socket.WebSocketLike {
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
        if (size > rpcLimits.inboundBytes) return ws.close(1009);
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
 * The RPC link to one host's daemon, shared by the services built with it: one connection per
 * connection generation, opened on first use with a fresh upgrade proof and again after it
 * closes. A request is sent once: one whose connection drops, whose reply is late or arrives
 * after the generation changed is `Unavailable`, or `Uncertain` for a mutation.
 */
export class DaemonRpcLink extends Context.Service<
  DaemonRpcLink,
  {
    readonly host: ChatHostTarget;
    /**
     * Sends one request; `check` refuses a reply against the daemon's signed health. It fails with
     * `E`, the errors its procedure declares, or the link's own.
     */
    call<A, E extends RemoteError>(
      operation: string,
      payload: object,
      options: {
        mutation: boolean;
        capability: string;
        check?: (output: A, health: ChatHostHealth) => void;
      },
    ): Effect.Effect<A, E | DaemonLinkError>;
    /**
     * Follows a watch: its updates applied to the value they describe, each value decoded and
     * checked. When its connection drops it subscribes again within a budget of
     * `streamLimits.reconnectMs` per outage and starts from a fresh value; it fails when the daemon
     * ends it, the connection generation changes or the budget runs out.
     */
    watch<K extends SocketSubscriptionKind, E extends RemoteError>(
      operation: string,
      kind: K,
      payload: object,
      options: {
        capability: string;
        check?: (value: SocketSubscriptionValue<K>) => void;
      },
    ): Stream.Stream<WatchUpdate<SocketSubscriptionValue<K>>, E | DaemonLinkError>;
  }
>()('moonbase/DaemonRpcLink') {}

export const DaemonRpcLinkLive = (config: { host: ChatHostTarget }) =>
  Layer.effect(
    DaemonRpcLink,
    Effect.gen(function* () {
      const connections = yield* ConnectionService;
      const host = config.host;
      const lookUpEndpoint = connections.endpoint({ host });
      const lock = yield* Semaphore.make(1);
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
            const url = new URL(rpcPath, endpoint.origin.replace(/^http:/, 'ws:'));
            // The connection closes with the scope that acquired it.
            const ws = yield* Effect.acquireRelease(
              Effect.sync(
                () =>
                  new globalThis.WebSocket(
                    url,
                    upgradeProtocols(endpoint.token, upgradeNonce, endpoint.expected),
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
            return boundInbound(ws);
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
          const transport = RpcClient.layerProtocolSocket({ retryPolicy: Schedule.recurs(0) }).pipe(
            Layer.provide([
              Layer.effect(
                Socket.Socket,
                Socket.fromWebSocket(acquire, { openTimeout: socketLimits.connectMs }),
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
          const client = yield* RpcClient.make(DaemonRpcs, { disableTracing: true }).pipe(
            Effect.provideContext(context),
            Scope.provide(scope),
          );
          const health = yield* Deferred.await(opened).pipe(
            Effect.timeoutOrElse({
              duration: socketLimits.connectMs,
              orElse: () => Effect.fail(unavailable('unreachable')),
            }),
            Effect.tapError(() => Scope.close(scope, Exit.void)),
          );
          return Object.assign(generation, { client, health });
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

      return {
        host,
        call: <A, E extends RemoteError>(
          operation: string,
          payload: object,
          options: {
            mutation: boolean;
            capability: string;
            check?: (output: A, health: ChatHostHealth) => void;
          },
        ): Effect.Effect<A, E | DaemonLinkError> =>
          Effect.gen(function* () {
            const endpoint = yield* lookUpEndpoint;
            const generation = yield* connect(endpoint);
            if (!generation.health.capabilities.includes(options.capability))
              return yield* Effect.fail(notServed());
            const procedure = (
              generation.client as unknown as Record<
                string,
                (payload: object) => Effect.Effect<unknown, unknown>
              >
            )[operation]!;
            const late = lostReply(options.mutation, operation);
            const exit = yield* Effect.exit(
              procedure(payload).pipe(
                Effect.timeoutOrElse({
                  duration: P.requestDeadlineMs,
                  orElse: () => Effect.fail(late),
                }),
              ),
            );
            if (Exit.isFailure(exit)) {
              if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt;
              const error = Cause.squash(exit.cause);
              if (error === late) return yield* Effect.fail(late);
              // Only an error the daemon's procedures declare is its answer; anything else lost it.
              if (isTransport(error) || !isOneOf(remoteErrors, error))
                return yield* Effect.fail(lostReply(options.mutation, operation));
            }
            // A reply belongs to the generation it was sent on; one that changed since is stale.
            if (!(yield* isCurrent(endpoint)))
              return yield* Effect.fail(generationChanged(options.mutation, operation));
            if (Exit.isFailure(exit))
              return yield* Effect.fail(
                presentRemoteError(Cause.squash(exit.cause) as RemoteError, operation) as E,
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
          }),
        watch: <K extends SocketSubscriptionKind, E extends RemoteError>(
          operation: string,
          kind: K,
          payload: object,
          options: {
            capability: string;
            check?: (value: SocketSubscriptionValue<K>) => void;
          },
        ) =>
          Stream.callback<WatchUpdate<SocketSubscriptionValue<K>>, E | DaemonLinkError>(
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
                              Queue.failCause(
                                queue,
                                Cause.fail(generationChanged(false, operation)),
                              ),
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
                      const procedure = (
                        generation.client as unknown as Record<
                          string,
                          (payload: object) => Stream.Stream<unknown, unknown>
                        >
                      )[operation]!;
                      let state: SocketSubscriptionValue<K> | undefined;
                      const updates = procedure(payload).pipe(
                        Stream.mapError((error) =>
                          isTransport(error) || !isOneOf(remoteErrors, error)
                            ? error
                            : presentRemoteError(error as RemoteError, operation),
                        ),
                      );
                      yield* Stream.runForEach(updates, (raw) =>
                        Effect.try({
                          try: () => {
                            const update = raw as
                              | { kind: 'snapshot'; value: SocketSubscriptionValue<K> }
                              | { kind: 'delta'; delta: SocketDelta<K> };
                            let value: SocketSubscriptionValue<K>;
                            if (update.kind === 'snapshot') value = update.value;
                            else if (state === undefined)
                              throw new IncompatibleHostError({ reason: 'invalid-update' });
                            else value = applySocketDelta(kind, state, update.delta);
                            value = decodeSocketSubscriptionValue(kind, value);
                            options.check?.(value);
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
          ),
      };
    }),
  );
