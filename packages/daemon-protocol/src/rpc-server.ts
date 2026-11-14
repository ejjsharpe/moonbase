import { Effect, Layer } from 'effect';
import { RpcSchema, RpcSerialization, RpcServer } from 'effect/rpc';
import { ChatRpcs } from '@moonbase/contracts/chat-rpc';
import { LocalHostRpcs, ProviderSetupRpcs } from '@moonbase/contracts/daemon-rpc';
import { RpcAdmission } from '@moonbase/contracts/rpc-admission';
import { rpcLimits } from '@moonbase/contracts/rpc-upgrade';
import { HostUnavailableError } from '@moonbase/contracts/host-errors';
import { makeChatHandlers, makeDaemonHandlers, type RpcServices } from './rpc-handlers.ts';
import { makeRpcConnections, rpcSocketServerLayer } from './rpc-connections.ts';

export type RpcServerOptions = {
  /**
   * Admits one request, returning what ends it once it settles (a mutation's outlives its
   * connection), or throws a `HostUnavailableError` to refuse it.
   */
  admit(): () => void;
};
const busy = () => new HostUnavailableError({ reason: 'busy' });
const failed = () => new HostUnavailableError({ reason: 'failed' });

/**
 * The middleware every procedure runs under: the daemon admits the request (refused once it is
 * stopping), a connection keeps at most `rpcLimits.requests` requests and `rpcLimits.watches`
 * watches running, and a handler's defect is answered as a failed host with no diagnostics.
 */
function makeAdmission(options: RpcServerOptions) {
  const running = new Map<number, { requests: number; watches: number }>();
  return RpcAdmission.of((effect, { client, rpc }) =>
    Effect.suspend(() => {
      const kind = RpcSchema.isStreamSchema(rpc.successSchema) ? 'watches' : 'requests';
      const counts = running.get(client.id) ?? { requests: 0, watches: 0 };
      if (counts[kind] >= rpcLimits[kind]) return Effect.fail(busy());
      let release: () => void;
      try {
        release = options.admit();
      } catch (error) {
        return Effect.fail(error instanceof HostUnavailableError ? error : failed());
      }
      counts[kind]++;
      running.set(client.id, counts);
      return effect.pipe(
        Effect.catchDefect(() => Effect.fail(failed())),
        Effect.ensuring(
          Effect.sync(() => {
            counts[kind]--;
            if (!counts.requests && !counts.watches) running.delete(client.id);
            release();
          }),
        ),
      );
    }),
  );
}

/**
 * Serves the chat procedures, and a daemon's folder, control and provider setup procedures, to
 * the connections Bun upgrades on `/v3/rpc`. Handler defects never end a connection.
 */
export const serveRpc = (services: RpcServices, options: RpcServerOptions) =>
  Effect.gen(function* () {
    const connections = yield* makeRpcConnections();
    const protocol = RpcServer.layerProtocolSocketServer.pipe(
      Layer.provide([rpcSocketServerLayer(connections), RpcSerialization.layerJson]),
    );
    const shared = [protocol, Layer.succeed(RpcAdmission, makeAdmission(options))] as const;
    const chat = ChatRpcs.toLayer(makeChatHandlers(services));
    const server = services.daemon
      ? (() => {
          const { local, providers } = makeDaemonHandlers(services);
          return RpcServer.layer(ChatRpcs.merge(LocalHostRpcs, ProviderSetupRpcs), {
            disableFatalDefects: true,
            disableTracing: true,
          }).pipe(
            Layer.provide([
              chat,
              LocalHostRpcs.toLayer(local),
              ProviderSetupRpcs.toLayer(providers),
              ...shared,
            ]),
          );
        })()
      : RpcServer.layer(ChatRpcs, { disableFatalDefects: true, disableTracing: true }).pipe(
          Layer.provide([chat, ...shared]),
        );
    yield* Layer.build(server);
    return connections;
  });
