import { Effect, FiberSet } from 'effect';
import type {
  LocalHostHandlers,
  ChatServiceShape,
  ProviderSetupService,
} from '@moonbase/contracts/services';
import type {
  HostCommand,
  HostInput,
  WorkspaceHostClient,
} from '@moonbase/contracts/workspace-host';
import {
  decodeHostInput,
  hostInputCheckout,
  isHostCommand,
  isHostMutation,
} from '@moonbase/contracts/workspace-host-schema';
import { createHostHealthReply } from './health.ts';
import {
  HostVerificationError,
  toConnectionApplicationError,
} from '@moonbase/contracts/connection-errors';
import {
  chatHostCapabilities,
  chatHostVersion,
  chatProtocolVersion,
  type ChatHostCapability,
  type ChatHostHealth,
  type ChatHostTarget,
} from '@moonbase/contracts/host';
import { rpcLimits, rpcPath } from '@moonbase/contracts/rpc-upgrade';
import { ApplicationError } from '@moonbase/contracts/workspace';
import * as P from './protocol.ts';
import { fail } from '@moonbase/contracts/errors';
import { createSocketServer, type SocketData, type SocketSources } from './socket-server.ts';
import { serveBun, type BunServer, type BunWebSocket } from './bun-server.ts';
import { systemSocketClock, type SocketClock } from './socket-protocol.ts';
import { serveRpc } from './rpc-server.ts';
import type { RpcSocketData } from './rpc-connections.ts';
import { createUpgradeNonces, isUpgradeProof, readUpgradeProtocols } from './upgrade-proof.ts';

export type { SocketSources } from './socket-server.ts';
export { makeWorkspaceClient } from './workspace-server.ts';
export type { SocketClock } from './socket-protocol.ts';

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
 * How connections are counted and admitted, the legacy socket's clock (for tests) and, for a
 * daemon that composes the workspace file host, that host: the server then advertises
 * `workspace-v1` and serves its operations and the `workspace` subscription on `/v2/socket`.
 */
export type ChatSocketConfiguration = {
  sources?: SocketSources;
  clock?: SocketClock;
  workspace?: WorkspaceHostClient;
  /**
   * Admits one request or authenticated health probe, returning what ends it once its answer
   * settles (a mutation's outlives its connection), or throws to refuse it. A daemon counts
   * requests as use with it and refuses them once it is stopping.
   */
  admit?(): () => void;
  /** How long an RPC connection may send nothing; for tests. */
  rpcIdleMs?: number;
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
/** A `Sec-WebSocket-Key` is the base64 of 16 bytes. */
const isWebSocketKey = (key: string | null) =>
  key !== null && /^[A-Za-z0-9+/]{22}==$/.test(key) && Buffer.from(key, 'base64').length === 16;

type ListenerData = SocketData | RpcSocketData;

/**
 * Serves signed health at `/v1/health`, RPC at `/v3/rpc` (chat, and a daemon's folder, control
 * and provider setup procedures) and the workspace's WebSocket at `/v2/socket` on one 127.0.0.1
 * listener. The services are trusted local ones, as is `config`; only wire input is decoded here,
 * and replies are checked by the client that receives them. An RPC upgrade is authenticated
 * before Bun accepts it: its proof binds a nonce signed health issued (usable once, briefly) to
 * the token, this host and the protocol.
 */
export const serveChat = (
  config: ChatServerConfiguration,
  services: ChatServerServices,
  socket?: ChatSocketConfiguration,
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
        chatHostCapabilities.socket,
        ...(socket?.workspace ? [chatHostCapabilities.workspace] : []),
      ],
    };
    const configuration = yield* services.chat.getChatHost({ host: expected });
    if (JSON.stringify(configuration).includes(token))
      return yield* Effect.fail(
        new ApplicationError({
          code: 'InvalidInput',
          message: 'Keep the private host key separate from public chat identities and settings.',
        }),
      );
    const admit = socket?.admit ?? (() => () => {});
    const run = yield* FiberSet.makeRuntimePromise<never>();
    const nonces = createUpgradeNonces();
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
      {
        admit,
        ...(socket?.rpcIdleMs === undefined ? {} : { idleMs: socket.rpcIdleMs }),
      },
    );
    /**
     * Runs one workspace operation for this host's checkouts. The host journals each mutation by
     * its request ID, so a repeat replays the first outcome; `signal` cancels reads only, since a
     * mutation runs to completion even when its connection closes.
     */
    const dispatchWorkspace = async <K extends HostCommand>(
      operation: K,
      input: HostInput<K>,
      signal: AbortSignal,
    ) => {
      const workspace = socket?.workspace;
      if (!workspace || !health.capabilities.includes(chatHostCapabilities.workspace))
        return fail('Incompatible', 'This host does not serve that operation.');
      const checkout = hostInputCheckout(input);
      if (checkout && checkout.hostId !== expected.hostId)
        fail('Unauthorized', 'Workspace request target differs from this host.');
      return workspace.command(
        operation,
        input,
        isHostMutation(operation) ? undefined : { signal },
      );
    };
    const sockets = createSocketServer({
      token,
      host: expected,
      health,
      ...(socket?.workspace ? { workspace: socket.workspace } : {}),
      sources: socket?.sources ?? {},
      clock: socket?.clock ?? systemSocketClock,
      // Chat and daemon operations are served over RPC; this socket carries the workspace's.
      answer: async (operation, input, signal) => {
        try {
          if (!isHostCommand(operation))
            fail('Incompatible', 'This host serves chat and daemon operations over RPC.');
          const release = admit();
          try {
            return {
              ok: true,
              value: await dispatchWorkspace(operation, decodeHostInput(operation, input), signal),
            };
          } finally {
            release();
          }
        } catch (error) {
          return { ok: false, error: P.publicDaemonError(error) };
        }
      },
    });
    let closed = false,
      active = 0;
    /** Signed health: the proof is checked first, so an unauthenticated probe reaches nothing. */
    const answerHealth = async (request: Request) => {
      const headers = { ...plainHeaders, 'Content-Type': 'application/json' };
      try {
        const value = createHostHealthReply({
          token,
          nonce: request.headers.get('x-moonbase-nonce') ?? undefined,
          authorization: request.headers.get('authorization') ?? undefined,
          health,
          issue: () => nonces.issue(),
        });
        const release = admit();
        try {
          await run(services.chat.getChatHost({ host: expected }));
        } finally {
          release();
        }
        return new Response(JSON.stringify(value), { status: 200, headers });
      } catch (thrown) {
        const error =
          thrown instanceof HostVerificationError ? toConnectionApplicationError(thrown) : thrown;
        return new Response(JSON.stringify({ ok: false, error: P.publicError(error) }), {
          status: ApplicationError.is(error) && error.code === 'Unauthorized' ? 401 : 503,
          headers,
        });
      }
    };
    /**
     * Upgrades a request for RPC, or answers the status it is refused with, before Bun accepts
     * it: a browser's (403), anything but a plain local WebSocket handshake for `/v3/rpc` or one
     * that doesn't offer the RPC protocol and a proof (400), a proof that is not this host's for
     * a live nonce (401; the nonce is used up either way) and one past the connection cap (503).
     */
    const upgradeRpc = (request: Request, bun: BunServer<ListenerData>) => {
      const refuse = (status: number) => new Response(null, { status, headers: plainHeaders });
      const headers = request.headers;
      if (headers.get('origin') !== null) return refuse(403);
      if (!/^127\.0\.0\.1:\d+$/.test(headers.get('host') ?? '')) return refuse(400);
      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        return refuse(400);
      }
      if (
        request.method !== 'GET' ||
        url.pathname !== rpcPath ||
        url.search !== '' ||
        headers.get('upgrade')?.toLowerCase() !== 'websocket' ||
        headers.get('sec-websocket-version') !== '13' ||
        !isWebSocketKey(headers.get('sec-websocket-key'))
      )
        return refuse(400);
      const offered = readUpgradeProtocols(headers.get('sec-websocket-protocol'));
      if (!offered) return refuse(400);
      if (
        !nonces.consume(offered.nonce) ||
        !isUpgradeProof(token, expected, offered.nonce, offered.proof)
      )
        return refuse(401);
      if (rpc.count >= rpcLimits.connections) return refuse(503);
      if (
        !bun.upgrade(request, { data: { kind: 'rpc' }, headers: { 'Cache-Control': 'no-store' } })
      )
        return refuse(400);
      return undefined;
    };
    const isRpc = (ws: BunWebSocket<ListenerData>): ws is BunWebSocket<RpcSocketData> =>
      ws.data.kind === 'rpc';
    const legacy = sockets.websocket;
    const server = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          serveBun<ListenerData>({
            hostname: '127.0.0.1',
            port: config.port,
            // An HTTP connection idle this long is closed; health answers well within it.
            idleTimeout: 10,
            development: false,
            error: () => new Response(null, { status: 503, headers: plainHeaders }),
            fetch: async (request, bun) => {
              if (closed) return new Response(null, { status: 503, headers: plainHeaders });
              if (request.headers.get('upgrade') !== null) {
                try {
                  const path = new URL(request.url).pathname;
                  if (path === rpcPath) return upgradeRpc(request, bun);
                  return sockets.upgrade(request, bun as BunServer<SocketData>);
                } catch {
                  return new Response(null, { status: 400, headers: plainHeaders });
                }
              }
              if (active >= maximumRequests)
                return new Response(null, { status: 503, headers: plainHeaders });
              active++;
              try {
                const url = new URL(request.url);
                if (request.method === 'GET' && url.pathname === '/v1/health' && url.search === '')
                  return await answerHealth(request);
                return new Response(null, { status: 404, headers: plainHeaders });
              } catch {
                return new Response(JSON.stringify({ ok: false, error: P.publicError(null) }), {
                  status: 503,
                  headers: { ...plainHeaders, 'Content-Type': 'application/json' },
                });
              } finally {
                active--;
              }
            },
            websocket: {
              ...legacy,
              open: (ws) =>
                isRpc(ws) ? rpc.open(ws) : legacy.open(ws as BunWebSocket<SocketData>),
              message: (ws, message) =>
                isRpc(ws)
                  ? rpc.message(ws, message)
                  : legacy.message(ws as BunWebSocket<SocketData>, message),
              ping: (ws) => (isRpc(ws) ? undefined : legacy.ping(ws as BunWebSocket<SocketData>)),
              drain: (ws) =>
                isRpc(ws) ? rpc.drain(ws) : legacy.drain(ws as BunWebSocket<SocketData>),
              close: (ws) =>
                isRpc(ws) ? rpc.close(ws, 1006) : legacy.close(ws as BunWebSocket<SocketData>),
            },
          }),
        catch: () =>
          new ApplicationError({
            code: 'Unavailable',
            message: 'Chat host could not acquire its loopback listener or backing service.',
          }),
      }),
      (server) =>
        Effect.promise(async () => {
          closed = true;
          await sockets.close();
          await server.stop(true);
        }),
    );
    return { origin: `http://127.0.0.1:${server.port}` };
  });
