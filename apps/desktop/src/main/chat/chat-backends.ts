import { randomUUID } from 'node:crypto';
import { Cause, Effect, Exit } from 'effect';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { isCancelled, isUncertain } from '@moonbase/contracts/error-groups';
import type {
  ChatServiceShape,
  ConnectionServiceShape,
  ProviderSetupService,
} from '@moonbase/contracts/services';
import type { ChatSession } from '@moonbase/contracts/chat';
import type { DaemonClients, LocalDaemon } from '../daemon/local-daemon.ts';
import type { ChatConfiguration } from './config.ts';
import type { ChatTargetId, DesktopChatTarget } from '../../ipc/chat-rpcs.ts';
import type { RequestIds } from '../request-ids.ts';

/** A remote host's daemon in host mode, over its SSH connection. */
export type RemoteChat = {
  configuration: ChatConfiguration;
  chat: ChatServiceShape;
  connection: ConnectionServiceShape;
  providers: DaemonClients['providers'];
  folders: DaemonClients['folders'];
};
/** What a chat target's requests reach: its chat, provider setup and, for a remote host, connection. */
export type ChatTargetClients = {
  chat: ChatServiceShape;
  context: ChatSession;
  providers: ProviderSetupService['Service'];
  connection: ConnectionServiceShape | null;
};

export type ChatBackendsOptions = {
  /** The local daemon, found or started on demand. */
  local: Pick<LocalDaemon['Service'], 'get' | 'peek'>;
  remote?: RemoteChat | null;
  readonly pickFolder: Effect.Effect<string | null>;
  /** The identity this profile's workspace store has to the daemon. */
  installationId: string;
  /** Lets the editor open a checkout the daemon made for a chat. */
  adoptCheckout?(checkout: CheckoutTarget): void;
  /** Request IDs of chat operations left unknown, kept across reloads and restarts. */
  requestIds: RequestIds['Service'];
};

/**
 * The window's chat targets: the local daemon, reached on demand, and the configured remote host.
 * What a document holds of them (provider sign-ins, image URLs, Copies) is its own; see
 * `makeChatDocument`.
 */
export function makeChatBackends({
  local,
  remote = null,
  pickFolder,
  installationId,
  adoptCheckout = () => {},
  requestIds,
}: ChatBackendsOptions) {
  const reachLocal = local.get;
  const targets: DesktopChatTarget[] = [
    { id: 'local', label: 'Local', mode: 'local' },
    ...(remote
      ? [
          {
            id: 'remote' as const,
            label: remote.configuration.ssh.profile.label,
            mode: 'remote' as const,
          },
        ]
      : []),
  ];
  /**
   * Sends under a request ID kept durably before it is sent, so a repeat after a lost reply, a
   * reload or a restart asks for the first outcome. The ID is kept only while the outcome is
   * unknown (`Uncertain`, or cancelled); an answer, a refusal included, is final.
   */
  const withRequestId = <A, E>(key: string, send: (requestId: string) => Effect.Effect<A, E>) =>
    Effect.flatMap(requestIds.issue(key), (requestId) =>
      send(requestId).pipe(
        Effect.onExit((exit) => {
          if (Exit.isFailure(exit)) {
            const error = Cause.findErrorOption(exit.cause);
            const unknown =
              error._tag === 'None'
                ? Cause.hasInterrupts(exit.cause)
                : isUncertain(error.value) || isCancelled(error.value);
            if (unknown) return Effect.void;
          }
          // A kept ID only asks again for an outcome already known, so failing to forget it is
          // no reason to fail the request.
          return Effect.ignore(requestIds.forget(key), { log: 'Warn' });
        }),
      ),
    );

  return {
    targets,
    /** The target's clients: the local daemon's once it has been reached, and the remote host's. */
    findTarget: (backendId: ChatTargetId): Effect.Effect<ChatTargetClients | undefined> =>
      backendId === 'remote'
        ? Effect.succeed(
            remote
              ? {
                  chat: remote.chat,
                  context: remote.configuration.context,
                  providers: remote.providers,
                  connection: remote.connection,
                }
              : undefined,
          )
        : Effect.map(
            local.peek,
            (backend) =>
              backend && {
                chat: backend.chat,
                context: backend.session,
                providers: backend.providers,
                connection: null,
              },
          ),
    getContext: (backendId: ChatTargetId) =>
      backendId === 'local'
        ? Effect.map(reachLocal, (backend) => backend.session)
        : Effect.succeed(remote!.configuration.context),
    chooseFolder: Effect.gen(function* () {
      const backend = yield* reachLocal;
      const selection = yield* pickFolder;
      if (!selection) return null;
      const { path } = yield* backend.folders.approveFolder({
        host: backend.session.host,
        requestId: randomUUID(),
        path: selection,
      });
      return path;
    }),
    /**
     * Local chat's folders the native picker approved before, still the same directories, newest
     * first; or a remote host's approved roots and their folders, which it offers in place of a
     * picker for its disk.
     */
    recentFolders: (backendId: ChatTargetId = 'local') =>
      Effect.gen(function* () {
        if (backendId === 'remote') {
          if (!remote) return [];
          const { host } = remote.configuration.context;
          return (yield* remote.folders.listHostFolders({ host })).folders;
        }
        const backend = yield* local.peek;
        if (!backend) return [];
        return (yield* backend.folders.listRecentFolders({ host: backend.session.host })).folders;
      }),
    /**
     * Starts a new local chat's worktree from a folder the daemon lets local chat use: it derives
     * the location and makes the worktree, which it opens as a checkout, so the chat may use it and
     * the editor may then open it. `requestId` is the renderer's for this new chat's send in a
     * worktree, kept until it learns the outcome, so a repeat after a lost reply gets the first
     * worktree and another chat never does. A request its document's release interrupts leaves
     * the worktree on disk but offers it to no document.
     */
    createWorktree: (root: string, branch: string, requestId: string) =>
      Effect.gen(function* () {
        const backend = yield* reachLocal;
        yield* backend.folders.checkApprovedFolder({ host: backend.session.host, path: root });
        const created = yield* backend.workspace.createChatWorktree({
          installationId,
          requestId,
          root,
          branch,
        });
        yield* Effect.sync(() => adoptCheckout(created));
        return created.root;
      }),
    /**
     * Opens a local chat without a project's folder as a project where it is, so nothing moves and
     * the agent keeps working in the same place, then lists the chat under that project. The daemon
     * does both steps as one operation.
     */
    turnIntoProject: (conversationId: string) =>
      Effect.gen(function* () {
        const backend = yield* reachLocal;
        const created = yield* withRequestId(
          JSON.stringify(['turnChatIntoProject', conversationId]),
          (requestId) =>
            backend.workspace.turnChatIntoProject({
              installationId,
              requestId,
              target: { ...backend.session, conversationId },
            }),
        );
        yield* Effect.sync(() => adoptCheckout(created));
        return created.root;
      }),
    /**
     * Releases what a document's provider setup holds on each target. A remote host may be
     * disconnected or unreachable; it drops an owner it hasn't heard from in 30 minutes, so
     * releasing it there is best effort.
     */
    releaseOwner: (ownerId: string) =>
      Effect.gen(function* () {
        const backend = yield* local.peek;
        const [released] = yield* Effect.all(
          [
            Effect.exit(backend ? backend.providers.releaseOwner(ownerId) : Effect.void),
            remote ? Effect.ignore(remote.providers.releaseOwner(ownerId)) : Effect.void,
          ],
          { concurrency: 'unbounded' },
        );
        return yield* released;
      }),
  };
}
export type ChatBackends = ReturnType<typeof makeChatBackends>;
