import { decodeChatInput, isChatCommand } from '@moonbase/contracts/chat-schema';
import { Effect, Exit, type ManagedRuntime } from 'effect';
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
  isDaemonCommand,
  isDaemonMutation,
} from '@moonbase/contracts/daemon-schema';
import { LocalHostService, ProviderSetupService } from '@moonbase/contracts/services';
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
import { areJsonValuesEqual } from '@moonbase/contracts/common';
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
import { releaseResource, toApplicationError } from '@moonbase/effect';
import { ApplicationError } from '@moonbase/contracts/workspace';
import * as P from './protocol.ts';
import { isCancellableChatRead, isSameChatHost } from '@moonbase/contracts/chat-validation';
import { fail } from '@moonbase/contracts/errors';
import { createSocketServer, type SocketData, type SocketSources } from './socket-server.ts';
import { serveBun } from './bun-server.ts';
import { systemSocketClock, type SocketClock } from './socket-protocol.ts';

export type { SocketSources } from './socket-server.ts';
export { makeWorkspaceClient } from './workspace-server.ts';
export type { SocketClock } from './socket-protocol.ts';

export type ChatServerConfiguration = { host: ChatHostTarget; token: string; port: number };
/**
 * What the WebSocket pushes beyond chats and their list, its clock (for tests) and, for a daemon
 * that composes the workspace file host, that host: the server then advertises `workspace-v1` and
 * serves its operations and the `workspace` subscription.
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
/** Request IDs of recent daemon mutations; a repeat of one returns its outcome instead of rerunning. */
const rememberedDaemonRequests = 256;
// Codes a daemon raises only before it applies anything, so a refused request may be sent again.
const refusalCodes = new Set<string>(['InvalidInput', 'Unauthorized', 'Incompatible', 'Conflict']);

/**
 * Serves the WebSocket at `/v2/socket` and signed health at `/v1/health` on one 127.0.0.1
 * listener. The injected clients are bound to the consumer's process root and shared handlers.
 * They are trusted local services, as is `config`; only wire input is decoded here, and replies
 * are checked by the client that receives them. A local-mode daemon also supplies `daemon`, its
 * folder, control and provider setup operations, and its health then advertises them.
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
        const { host: expected, token } = config;
        const health: ChatHostHealth = {
          ...expected,
          protocol: chatProtocolVersion,
          version: chatHostVersion,
          capabilities: [
            chatHostCapabilities.chat,
            ...(daemon ? daemonCapabilities : []),
            chatHostCapabilities.socket,
            ...(socket?.workspace ? [chatHostCapabilities.workspace] : []),
          ],
        };
        const configuration = await client.command('getChatHost', { host: expected });
        if (JSON.stringify(configuration).includes(token))
          fail(
            'InvalidInput',
            'Keep the private host key separate from public chat identities and settings.',
          );
        const admit = socket?.admit ?? (() => () => {});
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
          if (!isSameChatHost(shape.host ?? shape.target!.host, expected))
            fail('Unauthorized', 'Daemon request target differs from this host.');
          // Only what health advertises is served, however the daemon's services were composed.
          if (!health.capabilities.includes(daemonCommandCapabilities[operation]))
            fail('Incompatible', 'This host does not serve that operation.');
          // Whether the daemon refused the request outright, so nothing of it applied.
          let refused = false;
          const run = () =>
            daemon!.command(operation, input).catch((error: unknown) => {
              refused = ApplicationError.is(error) && refusalCodes.has(error.code);
              throw error;
            });
          if (!isDaemonMutation(operation)) return run();
          // Keyed by owner too, so one owner's request IDs never answer for another's.
          const { requestId, ownerId } = input as { requestId: string; ownerId?: string },
            key = JSON.stringify([ownerId ?? null, requestId]),
            prior = daemonRequests.get(key);
          if (prior) {
            if (prior.operation !== operation || !areJsonValuesEqual(prior.input, input))
              fail('InvalidInput', 'Request ID is bound to another operation or input.');
            return prior.outcome as Promise<DaemonOutput<K>>;
          }
          const outcome = run();
          daemonRequests.set(key, { operation, input, outcome });
          for (const key of daemonRequests.keys()) {
            if (daemonRequests.size <= rememberedDaemonRequests) break;
            daemonRequests.delete(key);
          }
          // A refused request may be sent again. A failure that may have applied part of it
          // (any other code or an unknown error) is kept, so a repeat never reruns it.
          outcome.catch(() => {
            if (refused && daemonRequests.get(key)?.outcome === outcome) daemonRequests.delete(key);
          });
          return outcome;
        };
        /**
         * Runs one workspace operation for this host's checkouts. The host journals each mutation
         * by its request ID, so a repeat replays the first outcome; `signal` cancels reads only,
         * since a mutation runs to completion even when its connection closes.
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
        /** Runs one request: a daemon or workspace operation, or a chat operation that `signal` may cancel. */
        const runOperation = async (operation: unknown, input: unknown, signal: AbortSignal) => {
          if (isHostCommand(operation))
            return dispatchWorkspace(operation, decodeHostInput(operation, input), signal);
          if (daemon && isDaemonCommand(operation))
            return dispatchDaemon(operation, decodeDaemonInput(operation, input));
          if (!isChatCommand(operation)) return fail('InvalidInput', 'Unknown chat operation.');
          const command = operation,
            decoded = decodeChatInput(command, input);
          return client.command(
            command,
            decoded,
            isCancellableChatRead(command) ? { signal } : undefined,
          );
        };
        const describeFailure = (operation: unknown, error: unknown) =>
          (daemon && isDaemonCommand(operation)) || isHostCommand(operation)
            ? P.publicDaemonError(error)
            : P.publicError(error, typeof operation === 'string' ? operation : undefined);
        const sockets = createSocketServer({
          token,
          host: expected,
          health,
          client,
          ...(daemon ? { daemon } : {}),
          ...(socket?.workspace ? { workspace: socket.workspace } : {}),
          sources: socket?.sources ?? {},
          clock: socket?.clock ?? systemSocketClock,
          answer: async (operation, input, signal) => {
            try {
              const release = admit();
              try {
                return { ok: true, value: await runOperation(operation, input, signal) };
              } finally {
                release();
              }
            } catch (error) {
              return { ok: false, error: describeFailure(operation, error) };
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
            });
            const release = admit();
            try {
              await client.command('getChatHost', { host: expected });
            } finally {
              release();
            }
            return new Response(JSON.stringify(value), { status: 200, headers });
          } catch (thrown) {
            const error =
              thrown instanceof HostVerificationError
                ? toConnectionApplicationError(thrown)
                : thrown;
            return new Response(JSON.stringify({ ok: false, error: P.publicError(error) }), {
              status: ApplicationError.is(error) && error.code === 'Unauthorized' ? 401 : 503,
              headers,
            });
          }
        };
        const server = serveBun<SocketData>({
          hostname: '127.0.0.1',
          port: config.port,
          // An HTTP connection idle this long is closed; health answers well within it.
          idleTimeout: 10,
          fetch: async (request, bun) => {
            if (closed) return new Response(null, { status: 503, headers: plainHeaders });
            if (request.headers.get('upgrade') !== null) return sockets.upgrade(request, bun);
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
          websocket: sockets.websocket,
        });
        return {
          origin: `http://127.0.0.1:${server.port}`,
          close: async () => {
            closed = true;
            await sockets.close();
            await server.stop(true);
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
    throw toApplicationError(
      exit.cause,
      new ApplicationError({ code: 'Unavailable', message: 'Daemon operation failed.' }),
    );
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
