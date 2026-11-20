import { Clock, Effect, Layer, Option, Ref, Scope, Stream, SubscriptionRef } from 'effect';
import { RpcClient, RpcSerialization, type Rpc, type RpcGroup } from 'effect/rpc';
import type { RpcClientError } from 'effect/rpc/RpcClientError';
import * as Socket from 'effect/socket/Socket';
import { isUnavailable } from '@moonbase/contracts/error-groups';
import {
  HostUnavailableError,
  IncompatibleHostError,
  type DaemonLinkError,
} from '@moonbase/contracts/host-errors';
import { chatHostCapabilities, type ChatHostHealth } from '@moonbase/contracts/host';
import { rpcLimits } from '@moonbase/contracts/rpc-upgrade';
import type { VerifiedChatEndpoint } from '@moonbase/contracts/services';
import { requestUpgradeNonce } from '../health.ts';
import { upgradeProtocols } from '../upgrade-proof.ts';
import { reconnectSchedule } from './reconnect-schedule.ts';

/** One socket of a host's daemon, as a connection to it opens. */
export type RpcSocketConfiguration<Rpcs extends Rpc.Any> = {
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
};

/**
 * Where a connection stands: opening its socket (with the health it was signed once read), open,
 * waiting to open it again after it dropped or failed to open, or given up on.
 */
type ConnectionState =
  | { _tag: 'connecting'; health?: ChatHostHealth }
  | { _tag: 'open'; health: ChatHostHealth }
  | { _tag: 'lost'; error: DaemonLinkError }
  | { _tag: 'closed'; error: DaemonLinkError };

/** A socket's typed RPC client: each procedure of its group, failing too with the transport's error. */
export type RpcConnectionClient<Rpcs extends Rpc.Any> = RpcClient.RpcClient<Rpcs, RpcClientError>;
/** One connection generation's link to a socket: its client, and when it may carry a request. */
export type RpcConnection<Rpcs extends Rpc.Any> = {
  client: RpcConnectionClient<Rpcs>;
  /**
   * The health of the open socket. While it waits to open again, the next attempt settles it: it
   * fails with why that attempt didn't open, or why it was given up on.
   */
  ready: Effect.Effect<ChatHostHealth, DaemonLinkError>;
  /** The health of the open socket, waiting through reconnects; fails once it is given up on. */
  reopened: Effect.Effect<ChatHostHealth, DaemonLinkError>;
  isOpen: Effect.Effect<boolean>;
};

const unavailable = (reason: HostUnavailableError['reason']) =>
  new HostUnavailableError({ reason });

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
 * Why an attempt to open the socket failed, and whether to try again: a daemon or host that can't
 * be reached now is retried; a refused proof, a host that isn't the one expected or doesn't serve
 * this socket, is not.
 */
const openFailure = (
  error: Socket.SocketError,
  isLinkError: (error: unknown) => error is DaemonLinkError,
): { error: DaemonLinkError; retryable: boolean } => {
  const reason = error.reason;
  if (reason._tag === 'SocketOpenError' && isLinkError(reason.cause))
    return {
      error: reason.cause,
      retryable: isUnavailable(reason.cause) && !isRefusedUpgrade(reason.cause),
    };
  // It didn't open in time, or went silent past the ping timeout while it opened.
  if (
    (reason._tag === 'SocketOpenError' && reason.kind === 'Timeout') ||
    reason._tag === 'SocketReadError'
  )
    return { error: unavailable('unreachable'), retryable: true };
  // The daemon closed the socket before it opened, or failed its upgrade: it refused it.
  return { error: unavailable('refused'), retryable: false };
};
const isRefusedUpgrade = (error: DaemonLinkError) =>
  error instanceof HostUnavailableError && error.reason === 'refused';

/**
 * Opens `endpoint`'s socket in the current scope, and opens it again when it drops on
 * `reconnectSchedule`. Each attempt reads signed health again for a fresh nonce, so every socket
 * carries its own proof (D13); one that is refused is not tried again. The RPC client fails what a
 * dropped socket carried and never resends it, and a write is only ever made to the socket open
 * when it was made, never held for the next. `onClosed` runs once the connection is given up on;
 * it must not wait for the connection's scope, which the RPC client's own retry runs in.
 */
export const openRpcConnection = <Rpcs extends Rpc.Any>(
  config: RpcSocketConfiguration<Rpcs>,
  endpoint: VerifiedChatEndpoint,
  isLinkError: (error: unknown) => error is DaemonLinkError,
  onClosed: Effect.Effect<void>,
): Effect.Effect<RpcConnection<Rpcs>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make<ConnectionState>({
      _tag: 'connecting',
    });
    // A connection whose scope closes, as an older generation's does, is closed to its waiters too.
    yield* Effect.addFinalizer(() =>
      SubscriptionRef.update(state, (now): ConnectionState =>
        now._tag === 'closed' ? now : { _tag: 'closed', error: unavailable('closed') },
      ),
    );
    const isOpen = Effect.map(SubscriptionRef.get(state), (now) => now._tag === 'open');
    /** When the current attempt's socket opened; none until it does. */
    const openedAt = yield* Ref.make<number | undefined>(undefined);
    /**
     * The WebSocket of the attempt being opened, and the open one, which a write goes out on:
     * open from `onConnect` until the reader's scope closes, none in between.
     */
    let opening: Socket.WebSocketLike | undefined, open: Socket.WebSocketLike | undefined;
    const acquire = Effect.gen(function* () {
      yield* Ref.set(openedAt, undefined);
      yield* SubscriptionRef.set(state, { _tag: 'connecting' });
      const { health, upgradeNonce } = yield* requestUpgradeNonce(endpoint);
      if (!health.capabilities.includes(chatHostCapabilities.rpc))
        return yield* Effect.fail(new IncompatibleHostError({ reason: 'not-daemon' }));
      if (config.capability !== undefined && !health.capabilities.includes(config.capability))
        return yield* Effect.fail(new IncompatibleHostError({ reason: 'not-served' }));
      yield* SubscriptionRef.set(state, { _tag: 'connecting', health });
      const url = new URL(config.path, endpoint.origin.replace(/^http:/, 'ws:'));
      // The socket closes with the scope of the attempt that opened it.
      const ws = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new globalThis.WebSocket(
              url,
              upgradeProtocols(endpoint.token, upgradeNonce, endpoint.expected, config.protocol),
            ),
        ),
        (ws) => Effect.sync(() => ws.close()),
      );
      opening = boundInbound(ws, config.inboundBytes);
      return opening;
    }).pipe(
      Effect.mapError(
        (error) =>
          new Socket.SocketError({
            reason: new Socket.SocketOpenError({
              kind: 'Unknown',
              cause: isLinkError(error) ? error : unavailable('unreachable'),
            }),
          }),
      ),
    );
    /**
     * Writes to the socket open now, in one synchronous step, or fails if none is. The socket
     * `fromWebSocket` makes holds a write made while it is disconnected and sends it on the next
     * socket, after the RPC client may have failed the request it carries as lost; this one never
     * holds a write, so none reaches a socket that opened after it was made.
     */
    const write = (chunks: readonly (Uint8Array | string | Socket.CloseEvent)[]) =>
      Effect.suspend(() => {
        const ws = open;
        if (ws === undefined)
          return Effect.fail(
            new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause: 'closed' }) }),
          );
        try {
          for (const chunk of chunks)
            if (Socket.isCloseEvent(chunk)) ws.close(chunk.code, chunk.reason);
            else ws.send(chunk as string | Uint8Array<ArrayBuffer>);
          return Effect.void;
        } catch (cause) {
          return Effect.fail(
            new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause }) }),
          );
        }
      });
    /**
     * The socket, read through `fromWebSocket` and written directly: open from when the RPC client
     * starts reading it (`onConnect`, once it has cleared the last socket's failure) until its
     * reader's scope closes, which marks it lost before the WebSocket is detached.
     */
    const socket = Effect.map(
      Socket.fromWebSocket(acquire, { openTimeout: rpcLimits.connectMs }),
      (inner) =>
        Socket.make({
          reader: Effect.gen(function* () {
            const reader = yield* inner.reader;
            yield* Effect.addFinalizer(() =>
              Effect.andThen(
                Effect.sync(() => {
                  open = undefined;
                }),
                SubscriptionRef.set(state, { _tag: 'lost', error: unavailable('closed') }),
              ),
            );
            return reader;
          }),
          writer: Effect.succeed({ write: (chunk) => write([chunk]), writeAll: write }),
        }),
    );
    /**
     * Settles a failed attempt: a dropped socket, or one that may yet open, waits to be retried;
     * otherwise the connection is given up on, in one step with `onClosed` so nothing finds it
     * given up on before then.
     */
    const settle = (error: Socket.SocketError, closed: boolean) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const now = yield* SubscriptionRef.get(state);
          // A dropped socket was marked lost as it closed; marking it again would settle a call
          // that started waiting since.
          if (now._tag === 'lost' && !closed) return;
          const failure = now._tag === 'lost' ? now.error : openFailure(error, isLinkError).error;
          yield* SubscriptionRef.set(state, { _tag: closed ? 'closed' : 'lost', error: failure });
          if (closed) yield* onClosed;
        }),
      );
    const retryPolicy = reconnectSchedule<Socket.SocketError>({
      // An attempt renews the budget only once its socket had been open `renewMs`.
      upSince: Ref.get(openedAt),
      // A dropped socket is opened again; an attempt that failed, only if it may yet open.
      isRetryable: (error) =>
        SubscriptionRef.getUnsafe(state)._tag === 'lost' ||
        openFailure(error, isLinkError).retryable,
      onRetry: (error) => settle(error, false),
      onStop: (error) => settle(error, true),
    });
    const transport = RpcClient.layerProtocolSocket({
      retryPolicy,
      ...(config.pingTimeoutMs === undefined ? {} : { pingTimeout: config.pingTimeoutMs }),
    }).pipe(
      Layer.provide([
        Layer.effect(Socket.Socket, socket),
        RpcSerialization.layerJson,
        Layer.succeed(RpcClient.ConnectionHooks, {
          onConnect: Effect.gen(function* () {
            open = opening;
            yield* Ref.set(openedAt, yield* Clock.currentTimeMillis);
            yield* SubscriptionRef.update(state, (now): ConnectionState =>
              now._tag === 'connecting' && now.health ? { _tag: 'open', health: now.health } : now,
            );
          }),
          // A dropped socket is marked lost as it closes, above.
          onDisconnect: Effect.void,
        }),
      ]),
    );
    const scope = yield* Effect.scope;
    const context = yield* Layer.buildWithScope(transport, scope);
    const client = yield* RpcClient.make(config.group, {
      disableTracing: true,
    }).pipe(Effect.provideContext(context), Scope.provide(scope));
    /**
     * The open socket's health, or why it isn't open, once the state is one `settled` takes: given
     * the state and whether it is the one current when asked.
     */
    const awaitState = (settled: (now: ConnectionState, current: boolean) => boolean) =>
      SubscriptionRef.changes(state).pipe(
        Stream.zipWithIndex,
        Stream.filter(([now, index]) => settled(now, index === 0)),
        Stream.map(([now]) => now),
        Stream.runHead,
        Effect.flatMap((now) =>
          Option.match(now, {
            onNone: () => Effect.fail<DaemonLinkError>(unavailable('closed')),
            onSome: (now) =>
              now._tag === 'open'
                ? Effect.succeed(now.health)
                : Effect.fail<DaemonLinkError>(
                    now._tag === 'connecting' ? unavailable('closed') : now.error,
                  ),
          }),
        ),
      );
    return {
      client,
      ready: awaitState(
        (now, current) =>
          now._tag === 'open' || now._tag === 'closed' || (now._tag === 'lost' && !current),
      ),
      reopened: awaitState((now) => now._tag === 'open' || now._tag === 'closed'),
      isOpen,
    };
  });
