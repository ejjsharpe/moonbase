import type { AddressInfo } from 'node:net';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Cause, Effect, Exit, type ManagedRuntime } from 'effect';
import type { ChatClient } from '@moonbase/contracts/chat';
import type {
  DaemonClient,
  DaemonCommand,
  DaemonInput,
  DaemonOutput,
} from '@moonbase/contracts/daemon';
import {
  daemonCommandCapabilities,
  decodeDaemonInput,
  decodeDaemonOutput,
  isDaemonCommand,
  isDaemonMutation,
} from '@moonbase/contracts/daemon-schema';
import { LocalHostService, ProviderSetupService } from '@moonbase/contracts/services';
import { areJsonValuesEqual } from '@moonbase/contracts/common';
import { createHostHealthReply, validateHostHealth } from '@moonbase/ssh/host-health';
import {
  chatHostCapabilities,
  chatHostVersion,
  chatProtocolVersion,
  type ChatHostCapability,
  type ChatHostTarget,
} from '@moonbase/contracts/host';
import { releaseResource } from '@moonbase/effect';
import { ApplicationError } from '@moonbase/contracts/workspace';
import * as P from './protocol.ts';
import * as V from './validation.ts';
import * as S from './private-schema.ts';
import { createSocketServer, type SocketSources } from './socket-server.ts';
import { systemSocketClock, type SocketClock } from './socket-protocol.ts';

export type { SocketSources } from './socket-server.ts';
export type { SocketClock } from './socket-protocol.ts';

export type ChatServerConfiguration = { host: ChatHostTarget; token: string; port: number };
/** What the WebSocket pushes beyond chats and their list, and its clock (for tests). */
export type ChatSocketConfiguration = { sources?: SocketSources; clock?: SocketClock };
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
/** Request IDs of recent daemon mutations; a repeat of one returns its outcome instead of rerunning. */
const rememberedDaemonRequests = 256;
// Codes a daemon raises only before it applies anything, so a refused request may be sent again.
const refusalCodes = new Set<string>(['InvalidInput', 'Unauthorized', 'Incompatible', 'Conflict']);

/**
 * Serves the WebSocket at `/v2/socket` and signed health at `/v1/health` on one 127.0.0.1
 * listener. The injected clients are bound to the consumer's process root and shared handlers.
 * They are the trusted local services, which already validate their replies and snapshots; only
 * wire input is decoded here. A local-mode daemon also supplies `daemon`, its folder, control and
 * provider setup operations, and its health then advertises them.
 */
export const serveChat = (
  config: ChatServerConfiguration,
  client: ChatClient,
  daemon?: DaemonClient,
  /** What the daemon operations add to health; a local-mode daemon's by default. */
  daemonCapabilities: readonly ChatHostCapability[] = localDaemonCapabilities,
  socket?: ChatSocketConfiguration,
) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const settings = S.serverConfiguration(config),
          expected = settings.host,
          token = settings.token;
        const health = validateHostHealth(
          {
            ...expected,
            protocol: chatProtocolVersion,
            version: chatHostVersion,
            capabilities: [
              chatHostCapabilities.chat,
              ...(daemon ? daemonCapabilities : []),
              chatHostCapabilities.socket,
            ],
          },
          expected,
        );
        const configuration = V.output(
          'getChatHost',
          await client.command('getChatHost', { host: expected }),
          { host: expected },
        );
        if (JSON.stringify(configuration).includes(token))
          V.fail(
            'InvalidInput',
            'Keep the private host key separate from public chat identities and settings.',
          );
        if (daemon && !('mode' in configuration))
          V.fail('InvalidInput', 'Serve daemon operations only for a local-mode chat host.');
        const daemonRequests = new Map<
          string,
          { operation: DaemonCommand; input: unknown; outcome: Promise<unknown> }
        >();
        /** Runs one daemon operation; a mutation's request ID binds its whole input. */
        const dispatchDaemon = async <K extends DaemonCommand>(
          operation: K,
          input: DaemonInput<K>,
        ): Promise<DaemonOutput<K>> => {
          const shape = input as { host?: ChatHostTarget; target?: { host: ChatHostTarget } };
          if (!V.sameHost(shape.host ?? shape.target!.host, expected))
            V.fail('Unauthorized', 'Daemon request target differs from this host.');
          // Only what health advertises is served, however the daemon's services were composed.
          if (!health.capabilities.includes(daemonCommandCapabilities[operation]))
            V.fail('Incompatible', 'This host does not serve that operation.');
          // Whether the daemon refused the request outright, so nothing of it applied.
          let refused = false;
          const run = async () => {
            const reply = await daemon!.command(operation, input).catch((error: unknown) => {
              refused = ApplicationError.is(error) && refusalCodes.has(error.code);
              throw error;
            });
            const value = decodeDaemonOutput(operation, reply);
            const requestId = (input as { requestId?: string }).requestId;
            if (
              requestId !== undefined &&
              (value as { requestId?: string }).requestId !== requestId
            )
              V.fail('Unavailable', 'Daemon request identity changed.');
            return value;
          };
          if (!isDaemonMutation(operation)) return run();
          // Keyed by owner too, so one owner's request IDs never answer for another's.
          const { requestId, ownerId } = input as { requestId: string; ownerId?: string },
            key = JSON.stringify([ownerId ?? null, requestId]),
            prior = daemonRequests.get(key);
          if (prior) {
            if (prior.operation !== operation || !areJsonValuesEqual(prior.input, input))
              V.fail('InvalidInput', 'Request ID is bound to another operation or input.');
            return prior.outcome as Promise<DaemonOutput<K>>;
          }
          const outcome = run();
          daemonRequests.set(key, { operation, input, outcome });
          for (const key of daemonRequests.keys()) {
            if (daemonRequests.size <= rememberedDaemonRequests) break;
            daemonRequests.delete(key);
          }
          // A refused request may be sent again. A failure that may have applied part of it
          // (any other code, an unknown error, or a bad reply) is kept, so a repeat never reruns it.
          outcome.catch(() => {
            if (refused && daemonRequests.get(key)?.outcome === outcome) daemonRequests.delete(key);
          });
          return outcome;
        };
        /** Runs one request: a daemon operation, or a chat operation that `signal` may cancel. */
        const runOperation = async (operation: unknown, input: unknown, signal: AbortSignal) => {
          if (daemon && isDaemonCommand(operation))
            return dispatchDaemon(operation, decodeDaemonInput(operation, input));
          const command = V.command(operation),
            decoded = V.input(command, input);
          return client.command(
            command,
            decoded,
            V.isCancellableRead(command) ? { signal } : undefined,
          );
        };
        const describeFailure = (operation: unknown, error: unknown) =>
          daemon && isDaemonCommand(operation)
            ? P.publicDaemonError(error)
            : P.publicError(error, typeof operation === 'string' ? operation : undefined);
        const sockets = createSocketServer({
          token,
          host: expected,
          health,
          client,
          ...(daemon ? { daemon } : {}),
          sources: socket?.sources ?? {},
          clock: socket?.clock ?? systemSocketClock,
          answer: (operation, input, signal) =>
            runOperation(operation, input, signal).then(
              (value) => ({ ok: true, value }),
              (error: unknown) => ({ ok: false, error: describeFailure(operation, error) }),
            ),
        });
        let closed = false,
          active = 0;
        const server = createServer((request, response) => {
          if (active >= 128) {
            response.writeHead(503);
            response.end();
            return;
          }
          active++;
          void handle(request, response)
            .catch(() => {
              if (!response.headersSent) {
                response.writeHead(503, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ ok: false, error: P.publicError(null) }));
              } else response.destroy();
            })
            .finally(() => {
              active--;
            });
        });
        server.requestTimeout = P.requestDeadlineMs;
        server.headersTimeout = 10000;
        server.maxConnections = 128;
        server.keepAliveTimeout = 1000;
        async function handle(request: IncomingMessage, response: ServerResponse) {
          if (closed) {
            response.writeHead(503);
            response.end();
            return;
          }
          response.setHeader('Cache-Control', 'no-store');
          if (request.method === 'GET' && request.url === '/v1/health') {
            try {
              // The proof is checked first: an unauthenticated probe never reaches the service.
              const value = createHostHealthReply({
                token,
                nonce: request.headers['x-moonbase-nonce'] as string | undefined,
                authorization: request.headers.authorization,
                health,
              });
              await client.command('getChatHost', { host: expected });
              response.writeHead(200, { 'content-type': 'application/json' });
              response.end(JSON.stringify(value));
            } catch (error) {
              response.writeHead(
                ApplicationError.is(error) && error.code === 'Unauthorized' ? 401 : 503,
                { 'content-type': 'application/json' },
              );
              response.end(JSON.stringify({ ok: false, error: P.publicError(error) }));
            }
            return;
          }
          response.writeHead(404);
          response.end();
        }
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(settings.port, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
          });
        });
        server.on('upgrade', (request, upgraded, head) => sockets.upgrade(request, upgraded, head));
        const address = server.address();
        if (!address || typeof address === 'string')
          V.fail('Unavailable', 'Chat loopback listener did not open.');
        return {
          origin: `http://127.0.0.1:${(address as AddressInfo).port}`,
          close: async () => {
            closed = true;
            await sockets.close();
            await new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
              server.closeAllConnections();
            });
          },
        };
      },
      catch: (error) =>
        ApplicationError.is(error)
          ? error
          : new ApplicationError({
              code: 'Unavailable',
              message: 'Chat host could not acquire its loopback listener or backing service.',
            }),
    }),
    (server) => releaseResource(() => server.close()),
  );

/**
 * Binds a process root's folder, control and provider setup services to the daemon operations
 * `serveChat` serves; the server has checked each input's host.
 */
export function makeDaemonClient(
  runtime: ManagedRuntime.ManagedRuntime<LocalHostService | ProviderSetupService, unknown>,
): DaemonClient {
  const run = async <A>(
    effect: Effect.Effect<A, ApplicationError, LocalHostService | ProviderSetupService>,
  ) => {
    const exit = await runtime.runPromiseExit(effect);
    if (Exit.isSuccess(exit)) return exit.value;
    const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
    throw ApplicationError.is(error)
      ? error
      : new ApplicationError({ code: 'Unavailable', message: 'Daemon operation failed.' });
  };
  const handlers: { [K in DaemonCommand]: (input: DaemonInput<K>) => Promise<DaemonOutput<K>> } = {
    approveFolder: (input) => run(Effect.flatMap(LocalHostService, (s) => s.approveFolder(input))),
    listRecentFolders: (input) =>
      run(Effect.flatMap(LocalHostService, (s) => s.listRecentFolders(input))),
    checkChatFolder: (input) =>
      run(Effect.flatMap(LocalHostService, (s) => s.checkChatFolder(input))),
    checkApprovedFolder: (input) =>
      run(Effect.flatMap(LocalHostService, (s) => s.checkApprovedFolder(input))),
    getActiveWork: (input) => run(Effect.flatMap(LocalHostService, (s) => s.getActiveWork(input))),
    markFolderAsProject: (input) =>
      run(Effect.flatMap(LocalHostService, (s) => s.markFolderAsProject(input))),
    listHostFolders: (input) =>
      run(Effect.flatMap(LocalHostService, (s) => s.listHostFolders(input))),
    getProviders: ({ ownerId }) =>
      run(
        Effect.flatMap(ProviderSetupService, (s) =>
          Effect.map(s.forOwner(ownerId).getProviders({}), (state) => ({ state })),
        ),
      ),
    startProviderLogin: ({ ownerId, requestId, providerId }) =>
      run(
        Effect.flatMap(ProviderSetupService, (s) =>
          Effect.map(s.forOwner(ownerId).startProviderLogin({ providerId }), (state) => ({
            requestId,
            state,
          })),
        ),
      ),
    answerProviderPrompt: ({ ownerId, requestId, flowId, promptId, answer }) =>
      run(
        Effect.flatMap(ProviderSetupService, (s) =>
          Effect.map(
            s.forOwner(ownerId).answerProviderPrompt({ flowId, promptId, answer }),
            (state) => ({ requestId, state }),
          ),
        ),
      ),
    cancelProviderLogin: ({ ownerId, requestId, flowId }) =>
      run(
        Effect.flatMap(ProviderSetupService, (s) =>
          Effect.map(s.forOwner(ownerId).cancelProviderLogin({ flowId }), (state) => ({
            requestId,
            state,
          })),
        ),
      ),
    openProviderUrl: ({ ownerId, flowId }) =>
      run(
        Effect.flatMap(ProviderSetupService, (s) =>
          Effect.flatMap(s.getProviderUrl(ownerId, flowId), (url) =>
            Effect.map(s.forOwner(ownerId).getProviders({}), (state) => ({ state, url })),
          ),
        ),
      ),
    logoutProvider: ({ ownerId, requestId, providerId }) =>
      run(
        Effect.flatMap(ProviderSetupService, (s) =>
          Effect.map(s.forOwner(ownerId).logoutProvider({ providerId }), (state) => ({
            requestId,
            state,
          })),
        ),
      ),
    releaseProviderOwner: ({ ownerId }) =>
      run(Effect.flatMap(ProviderSetupService, (s) => s.releaseOwner(ownerId))),
  };
  return {
    command: (operation, input) => {
      if (!Object.hasOwn(handlers, operation))
        return Promise.reject(
          new ApplicationError({ code: 'InvalidInput', message: 'Unknown daemon operation.' }),
        );
      return (handlers[operation] as (input: unknown) => Promise<never>)(input);
    },
  };
}
