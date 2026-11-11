import type { NativeTranscriptActions } from '../chat/transcript-native.ts';
import { randomUUID } from 'node:crypto';
import type { Effect, ManagedRuntime } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { ChatClient } from '@moonbase/contracts/chat';
import type { ConnectionClient } from '@moonbase/contracts/connection';
import { bindChatClient, bindProviderSetupClient } from '@moonbase/application/runtime/clients';
import { runApplicationEffect } from '@moonbase/application/runtime/effect-client';
import type { DaemonChat } from '../chat/daemon.ts';
import type { ChatConfiguration } from '../chat/config.ts';
import { ChatIpcSession } from '../chat/session.ts';
import type { Reply, DesktopChatTarget } from '../chat/wire.ts';

type LocalResult = { backend: DaemonChat | null; error: ApplicationError | null };

export function createChatBackends({
  runtime,
  localResult,
  acquireLocal,
  chatConfiguration,
  remoteChat,
  connection,
  emit,
  pickFolder,
  isEditorFolder = () => false,
  createWorktree,
  openFolderProject,
  transcript,
}: {
  runtime: ManagedRuntime.ManagedRuntime<never, ApplicationError>;
  localResult: LocalResult;
  acquireLocal(): Promise<LocalResult>;
  chatConfiguration: ChatConfiguration | null;
  remoteChat: ChatClient | null;
  connection: ConnectionClient | null;
  emit(backendId: string, id: string, result: Reply): void;
  pickFolder(): Promise<string | null>;
  /** Whether a folder is a checkout or worktree the editor approved natively. */
  isEditorFolder?(path: string): boolean;
  /** Creates a linked worktree of the checkout at `root`, returning its root. */
  createWorktree?(root: string, branch: string, signal: AbortSignal): Promise<string>;
  /** Opens a folder main trusts as a project, approving it for the editor; returns its root. */
  openFolderProject?(root: string): Promise<string>;
  transcript?: NativeTranscriptActions;
}) {
  let local = localResult.backend;
  let localRetry: Promise<void> | undefined;
  const sessions = new Map<string, ChatIpcSession>();
  /** Worktree creations for the current document; replacing the document cancels them. */
  const worktreeCreations = new Set<AbortController>();
  /** Editor folders granted to the daemon by this process, or being granted. */
  const grants = new Map<string, Promise<void>>();
  let documentId = randomUUID();
  const run = <A>(effect: Effect.Effect<A, ApplicationError>) =>
    runApplicationEffect(runtime, effect);
  const emitChat = (backendId: string) => (id: string, result: Reply) => {
    emit(backendId, id, result);
  };
  /**
   * Grants the daemon a checkout the editor approved, so local chat may use it. The daemon keeps
   * the grant (unlisted among recent folders) and re-checks the folder's identity on use.
   */
  const grantEditorFolder = (path: string) => {
    if (!local) return Promise.resolve();
    const backend = local;
    let grant = grants.get(path);
    if (!grant) {
      grant = run(
        backend.folders.approveFolder({
          host: backend.session.host,
          requestId: randomUUID(),
          path,
          recent: false,
        }),
      ).then(() => {});
      grants.set(path, grant);
      // A failed grant is tried again on the folder's next use.
      grant.catch(() => grants.delete(path));
    }
    return grant;
  };
  const installChatSessions = () => {
    if (local && !sessions.has('local'))
      sessions.set(
        'local',
        new ChatIpcSession(
          runtime,
          bindChatClient(runtime, local.chat),
          { mode: 'local' },
          local.session,
          emitChat('local'),
          {
            transcript,
            providers: bindProviderSetupClient(runtime, local.providers, documentId),
            // An editor folder a chat names is granted first; any other path grants nothing.
            prepareFolder: async (path) => {
              if (isEditorFolder(path)) await grantEditorFolder(path);
            },
          },
        ),
      );
    if (chatConfiguration && remoteChat && connection && !sessions.has('remote'))
      sessions.set(
        'remote',
        new ChatIpcSession(
          runtime,
          remoteChat,
          { mode: 'remote', connection },
          chatConfiguration.context,
          emitChat('remote'),
          { transcript },
        ),
      );
  };
  installChatSessions();
  const targets: DesktopChatTarget[] = [
    {
      id: 'local',
      label: 'Local',
      mode: 'local',
      context: local?.session ?? {
        host: { hostId: 'unavailable-local', storeId: 'unavailable-local' },
        actorId: 'unavailable-local',
      },
    },
    ...(chatConfiguration
      ? [
          {
            id: 'remote',
            label: chatConfiguration.ssh.profile.label,
            mode: 'remote' as const,
            context: chatConfiguration.context,
          },
        ]
      : []),
  ];
  const requireBackend = (message: string) => {
    if (!local) throw new ApplicationError({ code: 'Unavailable', message });
    return local;
  };
  const releaseChatDocument = async () => {
    const owner = documentId;
    for (const creation of worktreeCreations) creation.abort();
    worktreeCreations.clear();
    const closing = [...sessions.values()].map((session) => session.dispose());
    sessions.clear();
    documentId = randomUUID();
    installChatSessions();
    const results = await Promise.allSettled([
      ...closing,
      ...(local ? [run(local.providers.releaseOwner(owner))] : []),
    ]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  };

  return {
    getTargets: () => targets,
    getSession: (backendId: string) => sessions.get(backendId),
    getSessions: (): Pick<ChatIpcSession, 'dispose'>[] => [...sessions.values()],
    findTranscriptImage: (token: string) =>
      [...sessions.values()].map((session) => session.findImage(token)).find(Boolean),
    async getContext(backendId: string) {
      if (backendId === 'local' && !local) {
        localRetry ??= (async () => {
          localResult = await acquireLocal();
          local = localResult.backend;
          if (local) {
            targets[0] = { ...targets[0], context: local.session };
            installChatSessions();
          }
        })().finally(() => {
          localRetry = undefined;
        });
        await localRetry;
      }
      if (backendId === 'local' && !local) throw localResult.error;
      return targets.find((target) => target.id === backendId)!.context;
    },
    /** Grants the daemon a checkout the editor just approved; failures wait for its next use. */
    grantEditorFolder: (path: string) => {
      void grantEditorFolder(path).catch(() => {});
    },
    async chooseFolder() {
      const backend = requireBackend('Folder selection is unavailable.');
      const owner = documentId;
      const selection = await pickFolder();
      if (owner !== documentId || !selection) return null;
      const { path } = await run(
        backend.folders.approveFolder({
          host: backend.session.host,
          requestId: randomUUID(),
          path: selection,
        }),
      );
      return path;
    },
    /** Folders the native picker approved before, still the same directories, newest first. */
    async recentFolders() {
      if (!local) return [];
      return (await run(local.folders.listRecentFolders({ host: local.session.host }))).folders;
    },
    /**
     * Starts a new local chat's worktree from a folder local chat may use, and approves the new
     * worktree as that chat's working folder.
     */
    async createWorktree(root: string, branch: string) {
      const backend = requireBackend('New worktrees are unavailable.');
      if (!createWorktree)
        throw new ApplicationError({
          code: 'Unavailable',
          message: 'New worktrees are unavailable.',
        });
      const owner = documentId,
        creation = new AbortController();
      worktreeCreations.add(creation);
      try {
        if (isEditorFolder(root)) await grantEditorFolder(root);
        else
          await run(
            backend.folders.checkApprovedFolder({ host: backend.session.host, path: root }),
          );
        const created = await createWorktree(root, branch, creation.signal);
        // A replaced document's worktree is left on disk but not approved for the new document.
        if (owner !== documentId)
          throw new ApplicationError({
            code: 'Cancelled',
            message: 'The window reloaded while the worktree was created.',
          });
        const { path } = await run(
          backend.folders.approveFolder({
            host: backend.session.host,
            requestId: randomUUID(),
            path: created,
            recent: false,
          }),
        );
        return path;
      } finally {
        worktreeCreations.delete(creation);
      }
    },
    /**
     * Opens a local chat without a project's folder as a project where it is, so nothing moves and
     * the agent keeps working in the same place, then lists the chat under that project.
     */
    async turnIntoProject(conversationId: string) {
      const backend = requireBackend('Turning a chat into a project is unavailable.');
      if (!openFolderProject)
        throw new ApplicationError({
          code: 'Unavailable',
          message: 'Turning a chat into a project is unavailable.',
        });
      const owner = documentId,
        target = { ...backend.session, conversationId };
      const { conversation } = await run(backend.chat.getChat({ target }));
      if (!conversation.ownFolder)
        throw new ApplicationError({
          code: 'InvalidInput',
          message: 'Only a chat without a project can become one.',
        });
      await run(
        backend.folders.checkChatFolder({ host: backend.session.host, path: conversation.cwd }),
      );
      // Opening first leaves the chat as it was if that fails; a retry opens the same folder again.
      const root = await openFolderProject(conversation.cwd);
      if (owner !== documentId)
        throw new ApplicationError({
          code: 'Cancelled',
          message: 'The window reloaded while the project was opened.',
        });
      await run(backend.folders.markFolderAsProject({ requestId: randomUUID(), target }));
      return root;
    },
    requireLocal(backendId: string) {
      if (backendId === 'local' && !local) throw localResult.error;
    },
    releaseDocument: releaseChatDocument,
  };
}
export type DesktopChatBackends = ReturnType<typeof createChatBackends>;
