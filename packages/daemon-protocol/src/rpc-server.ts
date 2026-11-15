import { Effect, Layer } from 'effect';
import { RpcSchema, RpcSerialization, RpcServer } from 'effect/rpc';
import { ChatRpcs } from '@moonbase/contracts/chat-rpc';
import { LocalHostRpcs, ProviderSetupRpcs } from '@moonbase/contracts/daemon-rpc';
import { RpcAdmission } from '@moonbase/contracts/rpc-admission';
import { rpcLimits, workspaceRpcLimits } from '@moonbase/contracts/rpc-upgrade';
import { HostUnavailableError } from '@moonbase/contracts/host-errors';
import { WorkspaceRpcs } from '@moonbase/contracts/workspace-rpc';
import { makeChatHandlers, makeDaemonHandlers, type RpcServices } from './rpc-handlers.ts';
import {
  makeRpcConnections,
  rpcSocketServerLayer,
  type RpcConnectionOptions,
} from './rpc-connections.ts';
import { makeWorkspaceHandlers, type WorkspaceRpcServices } from './workspace-handlers.ts';

export type RpcServerOptions = {
  /**
   * Admits one request, returning what ends it once it settles (a mutation's outlives its
   * connection), or throws a `HostUnavailableError` to refuse it.
   */
  admit(): () => void;
};
/** What one connection may run at once on a socket. */
type AdmissionLimits = {
  requests: number;
  watches: number;
  /** Places of their own for `status` procedures, apart from `requests`. */
  status?: { procedures: ReadonlySet<string>; requests: number };
  /** Request input the connection's running requests may hold, by `estimateBytes`. */
  inFlightBytes?: number;
};
const busy = () => new HostUnavailableError({ reason: 'busy' });
const failed = () => new HostUnavailableError({ reason: 'failed' });

/**
 * At most the bytes `value` takes as JSON, counted without encoding it: its strings' and keys'
 * characters with their quotes, and its other values as written. Separators and escapes are not
 * counted, so a client that charges a request its encoded length never passes the bound first.
 */
function estimateBytes(value: unknown): number {
  let bytes = 0;
  const pending = [value];
  while (pending.length) {
    const next = pending.pop();
    if (typeof next === 'string') bytes += next.length + 2;
    else if (Array.isArray(next)) {
      bytes += 2;
      for (const item of next) pending.push(item);
    } else if (next !== null && typeof next === 'object') {
      bytes += 2;
      for (const [key, item] of Object.entries(next)) {
        // JSON leaves out a key whose value is undefined.
        if (item === undefined) continue;
        bytes += key.length + 3;
        pending.push(item);
      }
    } else if (next !== undefined) bytes += String(next).length;
  }
  return bytes;
}

/** Which of a connection's limits a procedure counts against. */
const kindOf = (limits: AdmissionLimits, rpc: { _tag: string; successSchema: unknown }) => {
  if (RpcSchema.isStreamSchema(rpc.successSchema as never)) return 'watches' as const;
  return limits.status?.procedures.has(rpc._tag) ? ('status' as const) : ('requests' as const);
};

/**
 * The middleware every procedure runs under: the daemon admits the request (refused once it is
 * stopping), a connection keeps at most `limits` running, and a handler's defect is answered as
 * a failed host with no diagnostics. A request past a limit is refused `busy` before it runs. The
 * input bound counts only plain requests, so status calls and watches always have their places.
 * Each check and the count it reserves happen in one synchronous, uninterruptible step with the
 * release that undoes it.
 */
function makeAdmission(options: RpcServerOptions, limits: AdmissionLimits) {
  type Counts = { requests: number; watches: number; status: number; bytes: number };
  const running = new Map<number, Counts>();
  return RpcAdmission.of((effect, { client, rpc, payload }) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const kind = kindOf(limits, rpc);
        const counts = running.get(client.id) ?? { requests: 0, watches: 0, status: 0, bytes: 0 };
        const limit = {
          requests: limits.requests,
          watches: limits.watches,
          status: limits.status?.requests ?? 0,
        }[kind];
        const bytes =
          kind === 'requests' && limits.inFlightBytes !== undefined ? estimateBytes(payload) : 0;
        if (counts[kind] >= limit || (bytes > 0 && counts.bytes + bytes > limits.inFlightBytes!))
          return Effect.fail(busy());
        let release: () => void;
        try {
          release = options.admit();
        } catch (error) {
          return Effect.fail(error instanceof HostUnavailableError ? error : failed());
        }
        counts[kind]++;
        counts.bytes += bytes;
        running.set(client.id, counts);
        return restore(effect).pipe(
          Effect.catchDefect(() => Effect.fail(failed())),
          Effect.ensuring(
            Effect.sync(() => {
              counts[kind]--;
              counts.bytes -= bytes;
              if (!counts.requests && !counts.watches && !counts.status) running.delete(client.id);
              release();
            }),
          ),
        );
      }),
    ),
  );
}

const serverOptions = { disableFatalDefects: true, disableTracing: true } as const;
/** The connections of one socket and the protocol an RPC server runs over them. */
const socketProtocol = (options: RpcConnectionOptions) =>
  Effect.map(makeRpcConnections(options), (connections) => ({
    connections,
    protocol: RpcServer.layerProtocolSocketServer.pipe(
      Layer.provide([rpcSocketServerLayer(connections), RpcSerialization.layerJson]),
    ),
  }));

/**
 * Serves the chat procedures, and a daemon's folder, control and provider setup procedures, to
 * the connections Bun upgrades on `/v3/rpc`. Handler defects never end a connection.
 */
export const serveRpc = (services: RpcServices, options: RpcServerOptions) =>
  Effect.gen(function* () {
    const { connections, protocol } = yield* socketProtocol({
      messageBytes: rpcLimits.messageBytes,
      queuedBytes: rpcLimits.queuedBytes,
    });
    const shared = [
      protocol,
      Layer.succeed(RpcAdmission, makeAdmission(options, rpcLimits)),
    ] as const;
    const chat = ChatRpcs.toLayer(makeChatHandlers(services));
    const server = services.daemon
      ? (() => {
          const { local, providers } = makeDaemonHandlers(services);
          return RpcServer.layer(
            ChatRpcs.merge(LocalHostRpcs, ProviderSetupRpcs),
            serverOptions,
          ).pipe(
            Layer.provide([
              chat,
              LocalHostRpcs.toLayer(local),
              ProviderSetupRpcs.toLayer(providers),
              ...shared,
            ]),
          );
        })()
      : RpcServer.layer(ChatRpcs, serverOptions).pipe(Layer.provide([chat, ...shared]));
    yield* Layer.build(server);
    return connections;
  });

/** The calls that resolve an `Uncertain` result, which keep places of their own. */
const statusProcedures: ReadonlySet<string> = new Set(['saveStatus', 'operationStatus']);
/**
 * Serves the file host's procedures and watch to the connections Bun upgrades on
 * `/v3/workspace`: a message up to `workspaceRpcLimits.messageBytes`, and per connection at most
 * its requests, status calls, watches and request input in flight. `track` counts a connection
 * while it is open.
 */
export const serveWorkspaceRpc = (
  services: WorkspaceRpcServices,
  options: RpcServerOptions & { track?(): () => void },
) =>
  Effect.gen(function* () {
    const { connections, protocol } = yield* socketProtocol({
      messageBytes: workspaceRpcLimits.messageBytes,
      queuedBytes: workspaceRpcLimits.queuedBytes,
      ...(options.track ? { track: options.track } : {}),
    });
    const admission = makeAdmission(options, {
      requests: workspaceRpcLimits.requests,
      watches: workspaceRpcLimits.watches,
      status: { procedures: statusProcedures, requests: workspaceRpcLimits.statusRequests },
      inFlightBytes: workspaceRpcLimits.inFlightBytes,
    });
    yield* Layer.build(
      RpcServer.layer(WorkspaceRpcs, serverOptions).pipe(
        Layer.provide([
          WorkspaceRpcs.toLayer(makeWorkspaceHandlers(services)),
          protocol,
          Layer.succeed(RpcAdmission, admission),
        ]),
      ),
    );
    return connections;
  });
