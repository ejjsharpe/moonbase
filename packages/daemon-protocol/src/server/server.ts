import { Clock, Effect, Exit, Fiber, FiberSet, Option, Scope, Semaphore } from 'effect';
import type {
  LocalHostHandlers,
  ChatServiceShape,
  ProviderSetupService,
  WorkspaceHostServiceShape,
} from '@moonbase/contracts/services';
import { createHostHealthReply } from '../health.ts';
import { HostVerificationError } from '@moonbase/contracts/connection-errors';
import { HostKeyExposedError, HostUnavailableError } from '@moonbase/contracts/host-errors';
import {
  chatHostCapabilities,
  chatHostVersion,
  chatProtocolVersion,
  type ChatHostCapability,
  type ChatHostHealth,
  type ChatHostTarget,
} from '@moonbase/contracts/host';
import {
  rpcLimits,
  rpcPath,
  rpcProtocol,
  workspaceRpcLimits,
  workspaceRpcPath,
  workspaceRpcProtocol,
} from '@moonbase/contracts/rpc-upgrade';
import { isAccessRefusal } from '@moonbase/contracts/error-groups';
import { UnauthorizedError } from '@moonbase/contracts/errors';
import { serveBun, type BunServer, type BunWebSocket } from './bun-server.ts';
import { serveRpc, serveWorkspaceRpc } from './rpc-server.ts';
import type { RpcConnections, RpcSocketData } from './rpc-connections.ts';
import { createUpgradeNonces, isUpgradeProof, readUpgradeProtocols } from '../upgrade-proof.ts';

export type ChatServerConfiguration = { host: ChatHostTarget; token: string; port: number };
/** What a daemon serves: chat, and in either mode its folder, control and provider services. */
export type ChatServerServices = {
  chat: ChatServiceShape;
  daemon?: {
    localHost: LocalHostHandlers;
    providers: ProviderSetupService['Service'];
    /** What the daemon operations add to health; `localDaemonCapabilities` or `hostDaemonCapabilities`. */
    capabilities: readonly ChatHostCapability[];
  };
};
/**
 * How requests are admitted and, for a daemon that composes the workspace file host, that host:
 * the server then advertises `workspace-v2` and serves it on its own socket, `/v3/workspace`.
 */
export type ChatServerOptions = {
  /** The file host; its methods need nothing from their context. */
  workspace?: WorkspaceHostServiceShape;
  /**
   * Admits one request, watch or authenticated health probe for as long as its scope is open,
   * which closes once its answer settles (a mutation's outlives its connection), or fails to refuse
   * it. A daemon counts requests as use with it and refuses them once it is stopping.
   */
  admit?: Effect.Effect<void, HostUnavailableError, Scope.Scope>;
  /** Held in each workspace connection's scope, from when it opens until it closes. */
  trackWorkspaceConnection?: Effect.Effect<void, never, Scope.Scope>;
  /**
   * How long closing the server waits, on the Clock, for the mutations it still runs and the
   * cleanup of the health probes it interrupts (5 s by default); past it the close goes on
   * without them and runs `onCloseTimeout`.
   */
  closeMs?: number;
  /** Runs once a close goes on without the work it waited for. */
  onCloseTimeout?: Effect.Effect<void>;
};
/** A local-mode daemon's features beyond chat: local-mode chat and control, providers, folders. */
export const localDaemonCapabilities: readonly ChatHostCapability[] = [
  chatHostCapabilities.local,
  chatHostCapabilities.providers,
  chatHostCapabilities.folders,
];
/** A host-mode daemon's: a local daemon's, and the approved roots a remote client chooses from. */
export const hostDaemonCapabilities: readonly ChatHostCapability[] = [
  ...localDaemonCapabilities,
  chatHostCapabilities.roots,
];
/**
 * Every plain HTTP answer is its connection's last: health is a one-off probe, and a client never
 * carries a probe's connection over into its WebSocket.
 */
const plainHeaders = { 'Cache-Control': 'no-store', Connection: 'close' };
/** HTTP requests the listener answers at once; more are refused `503`. */
const maximumRequests = 128;
/** Bun's own bound on a socket's buffered output; connections stop writing far below it. */
const backpressureLimit = 1024 * 1024 * 1024;
/** A `Sec-WebSocket-Key` is the base64 of 16 bytes. */
const isWebSocketKey = (key: string | null) =>
  key !== null && /^[A-Za-z0-9+/]{22}==$/.test(key) && Buffer.from(key, 'base64').length === 16;
/** The body of a refused health probe: its code and fixed text, nothing of why. */
const healthRefusal = (refused: boolean) =>
  JSON.stringify({
    ok: false,
    error: refused
      ? { code: 'Unauthorized', message: 'Chat request is not authorized.' }
      : { code: 'Unavailable', message: 'Chat host is unavailable.' },
  });

/**
 * Serves signed health at `/v1/health`, RPC at `/v3/rpc` (chat, and a daemon's folder, control
 * and provider setup procedures) and, given a file host, the workspace's own RPC socket at
 * `/v3/workspace`, on one 127.0.0.1 listener. The services are trusted local ones, as is `config`;
 * only wire input is decoded here, and replies are checked by the client that receives them. An
 * upgrade is authenticated before Bun accepts it: its proof binds a nonce signed health issued
 * (usable once, briefly) to the token, this host and the socket's protocol.
 */
export const serveChat = (
  config: ChatServerConfiguration,
  services: ChatServerServices,
  options: ChatServerOptions = {},
) =>
  Effect.gen(function* () {
    const { host: expected, token } = config;
    const health: ChatHostHealth = {
      ...expected,
      protocol: chatProtocolVersion,
      version: chatHostVersion,
      capabilities: [
        chatHostCapabilities.chat,
        ...(services.daemon?.capabilities ?? []),
        chatHostCapabilities.rpc,
        ...(options.workspace ? [chatHostCapabilities.workspace] : []),
      ],
    };
    const configuration = yield* services.chat.getChatHost({ host: expected });
    if (JSON.stringify(configuration).includes(token))
      return yield* Effect.fail(new HostKeyExposedError());
    const admit = options.admit ?? Effect.void;
    const clock = yield* Clock.Clock;
    const nonces = createUpgradeNonces(() => clock.currentTimeMillisUnsafe());
    // The RPC servers live in a scope of their own, which the listener's release closes. Should
    // the listener never start, the server's scope closes it.
    const serving = yield* Scope.fork(yield* Effect.scope);
    const rpc = yield* serveRpc(
      {
        host: expected,
        health,
        chat: services.chat,
        ...(services.daemon
          ? {
              daemon: {
                localHost: services.daemon.localHost,
                providers: services.daemon.providers,
              },
            }
          : {}),
      },
      { admit },
    ).pipe(Scope.provide(serving));
    const workspace = options.workspace
      ? yield* serveWorkspaceRpc(
          { host: expected, workspace: options.workspace },
          {
            admit,
            ...(options.trackWorkspaceConnection
              ? { track: options.trackWorkspaceConnection }
              : {}),
          },
        ).pipe(Scope.provide(serving))
      : undefined;
    /** Each socket Bun upgrades: its protocol, how many it holds at most, and its connections. */
    const sockets: Record<
      string,
      { kind: RpcSocketData['kind']; protocol: string; cap: number; connections: RpcConnections }
    > = {
      [rpcPath]: {
        kind: 'rpc',
        protocol: rpcProtocol,
        cap: rpcLimits.connections,
        connections: rpc,
      },
      ...(workspace
        ? {
            [workspaceRpcPath]: {
              kind: 'workspace' as const,
              protocol: workspaceRpcProtocol,
              cap: workspaceRpcLimits.connections,
              connections: workspace,
            },
          }
        : {}),
    };
    /**
     * The listener's plain HTTP answers run in its own scope: releasing the listener closes it,
     * interrupting the answers still running and refusing any later request.
     */
    const listening = yield* Scope.fork(yield* Effect.scope);
    const answer = yield* FiberSet.makeRuntimePromise<never>().pipe(Scope.provide(listening));
    const requests = yield* Semaphore.make(maximumRequests);
    const jsonHeaders = { ...plainHeaders, 'Content-Type': 'application/json' };
    /** Signed health: the proof is checked first, so an unauthenticated probe reaches nothing. */
    const answerHealth = (request: Request) =>
      Effect.try({
        try: () =>
          createHostHealthReply({
            token,
            nonce: request.headers.get('x-moonbase-nonce') ?? undefined,
            authorization: request.headers.get('authorization') ?? undefined,
            health,
            issue: () => nonces.issue(),
          }),
        // The reply refuses with a HostVerificationError; anything else it throws is a defect.
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          error instanceof HostVerificationError ? Effect.fail(error) : Effect.die(error),
        ),
        Effect.tap(() =>
          Effect.scoped(Effect.andThen(admit, services.chat.getChatHost({ host: expected }))),
        ),
        Effect.map(
          (value) => new Response(JSON.stringify(value), { status: 200, headers: jsonHeaders }),
        ),
        // A refused proof or an UnauthorizedError is 401. Any other failure, the chat service's
        // own refusals included, is 503; a defect or an interruption reaches the listener, which
        // answers it 503.
        Effect.catch((error) => {
          const refused =
            error instanceof HostVerificationError
              ? isAccessRefusal(error)
              : error instanceof UnauthorizedError;
          return Effect.succeed(
            new Response(healthRefusal(refused), {
              status: refused ? 401 : 503,
              headers: jsonHeaders,
            }),
          );
        }),
      );
    /** A plain HTTP request: health, or 404. */
    const respond = (request: Request) =>
      Effect.suspend(() => {
        const url = new URL(request.url);
        if (request.method === 'GET' && url.pathname === '/v1/health' && url.search === '')
          return answerHealth(request);
        return Effect.succeed(new Response(null, { status: 404, headers: plainHeaders }));
      });
    /**
     * Upgrades a request for one of the sockets, or answers the status it is refused with, before
     * Bun accepts it: a browser's (403), anything but a plain local WebSocket handshake for a
     * socket this daemon serves or one that doesn't offer its protocol and a proof (400), a proof
     * that is not this host's for a live nonce and that protocol (401; the nonce is used up either
     * way) and one past the socket's connection cap (503).
     */
    const upgrade = (request: Request, bun: BunServer<RpcSocketData>) => {
      const refuse = (status: number) => new Response(null, { status, headers: plainHeaders });
      const headers = request.headers;
      // A browser page always sends Origin; only privileged local processes may connect.
      if (headers.get('origin') !== null) return refuse(403);
      // Any port: through an SSH forward, Host names the client's local end of the tunnel. Bun
      // builds the request's URL from Host, so it is checked before the URL is read.
      if (!/^127\.0\.0\.1:\d+$/.test(headers.get('host') ?? '')) return refuse(400);
      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        return refuse(400);
      }
      const socket = Object.hasOwn(sockets, url.pathname) ? sockets[url.pathname] : undefined;
      if (
        !socket ||
        request.method !== 'GET' ||
        url.search !== '' ||
        headers.get('upgrade')?.toLowerCase() !== 'websocket' ||
        headers.get('sec-websocket-version') !== '13' ||
        !isWebSocketKey(headers.get('sec-websocket-key'))
      )
        return refuse(400);
      const offered = readUpgradeProtocols(headers.get('sec-websocket-protocol'), socket.protocol);
      if (!offered) return refuse(400);
      if (
        !nonces.consume(offered.nonce) ||
        !isUpgradeProof(token, expected, offered.nonce, offered.proof, socket.protocol)
      )
        return refuse(401);
      // Reserved now and taken when it opens, so upgrades accepted together stay under the cap.
      if (!socket.connections.reserve(socket.cap)) return refuse(503);
      let upgraded = false;
      try {
        upgraded = bun.upgrade(request, {
          data: { kind: socket.kind },
          headers: { 'Cache-Control': 'no-store' },
        });
      } finally {
        if (!upgraded) socket.connections.unreserve();
      }
      return upgraded ? undefined : refuse(400);
    };
    const connectionsOf = (ws: BunWebSocket<RpcSocketData>) =>
      ws.data.kind === 'workspace' ? workspace : rpc;
    const server = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          serveBun<RpcSocketData>({
            hostname: '127.0.0.1',
            port: config.port,
            // An HTTP connection idle this long is closed; health answers well within it.
            idleTimeout: 10,
            development: false,
            error: () => new Response(null, { status: 503, headers: plainHeaders }),
            fetch: async (request, bun) => {
              if (listening.state._tag === 'Closed')
                return new Response(null, { status: 503, headers: plainHeaders });
              if (request.headers.get('upgrade') !== null) {
                try {
                  return upgrade(request, bun);
                } catch {
                  return new Response(null, { status: 400, headers: plainHeaders });
                }
              }
              try {
                // Past `maximumRequests` answering at once, a request is refused.
                const answered = await answer(requests.withPermitsIfAvailable(1)(respond(request)));
                return Option.getOrElse(
                  answered,
                  () => new Response(null, { status: 503, headers: plainHeaders }),
                );
              } catch {
                return new Response(healthRefusal(false), { status: 503, headers: jsonHeaders });
              }
            },
            websocket: {
              // Bun refuses a larger message from its header; each socket holds its own messages
              // to a smaller bound, and no message arrives before an upgrade is authenticated.
              maxPayloadLength: workspace
                ? workspaceRpcLimits.messageBytes
                : rpcLimits.messageBytes,
              // Each socket's own idle limit decides when a connection is quiet.
              idleTimeout: 0,
              sendPings: false,
              backpressureLimit,
              closeOnBackpressureLimit: false,
              perMessageDeflate: false,
              open: (ws) => connectionsOf(ws)?.open(ws),
              message: (ws, message) => connectionsOf(ws)?.message(ws, message),
              ping: () => {},
              drain: (ws) => connectionsOf(ws)?.drain(ws),
              close: (ws) => connectionsOf(ws)?.close(ws, 1006),
            },
          }),
        catch: () => new HostUnavailableError({ reason: 'listener' }),
      }),
      // Releasing the listener starts three closes at once, none waiting on another to begin:
      // Bun's stop, first, so it cuts the connections before the RPC servers close them;
      // `listening`, which refuses later requests and interrupts the answers still running; and
      // the RPC servers', which waits for the mutations they run. The release then waits
      // for the answers' cleanup (each probe's admission) and the mutations, so neither outlives
      // the server's scope. A stuck helper could hold either for ever, so the wait is bounded by
      // `closeMs`; past it the release goes on without them (a mutation left unfinished was
      // journalled where it runs) and runs `onCloseTimeout`.
      (server) =>
        Effect.gen(function* () {
          const stopping = yield* Effect.forkDetach(
            Effect.promise(() => server.stop(true)),
            { startImmediately: true },
          );
          const closing = yield* Effect.forEach([listening, serving], (scope) =>
            Effect.forkDetach(Scope.close(scope, Exit.void), { startImmediately: true }),
          );
          yield* Effect.all(
            [
              Fiber.await(stopping),
              Fiber.awaitAll(closing).pipe(
                Effect.timeoutOrElse({
                  duration: options.closeMs ?? 5_000,
                  orElse: () => options.onCloseTimeout ?? Effect.void,
                }),
              ),
            ],
            { concurrency: 'unbounded', discard: true },
          );
        }),
    );
    return { origin: `http://127.0.0.1:${server.port}` };
  });
