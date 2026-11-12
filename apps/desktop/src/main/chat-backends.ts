import type { NativeTranscriptActions } from '../chat/transcript-native.ts';
import { randomUUID } from 'node:crypto';
import type { Effect, ManagedRuntime } from 'effect';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { ChatClient } from '@moonbase/contracts/chat';
import type { ConnectionClient } from '@moonbase/contracts/connection';
import { bindChatClient, bindProviderSetupClient } from '@moonbase/application/runtime/clients';
import { runApplicationEffect } from '@moonbase/application/runtime/effect-client';
import type { DaemonChat } from '../chat/daemon.ts';
import type { ChatConfiguration } from '../chat/config.ts';
import { ChatIpcSession } from '../chat/session.ts';
import type { Reply, DesktopChatTarget } from '../chat/wire.ts';
import { createMemoryRequestIds, type RequestIds } from './request-ids.ts';

type LocalResult = { backend: DaemonChat | null; error: ApplicationError | null };
/** A remote host's daemon in host mode, over its SSH connection. */
export type RemoteChat = {
  configuration: ChatConfiguration;
  chat: ChatClient;
  connection: ConnectionClient;
  providers: DaemonChat['providers'];
  folders: DaemonChat['folders'];
};

export function createChatBackends({
  runtime,
  localResult,
  acquireLocal,
  remote = null,
  emit,
  pickFolder,
  isEditorFolder = () => false,
  installationId,
  adoptCheckout = () => {},
  transcript,
  requestIds = createMemoryRequestIds(),
}: {
  runtime: ManagedRuntime.ManagedRuntime<never, ApplicationError>;
  localResult: LocalResult;
  acquireLocal(): Promise<LocalResult>;
  remote?: RemoteChat | null;
  emit(backendId: string, id: string, result: Reply): void;
  pickFolder(): Promise<string | null>;
  /** Whether a folder is a checkout or worktree the editor approved natively. */
  isEditorFolder?(path: string): boolean;
  /** The identity this profile's workspace store has to the daemon. */
  installationId: string;
  /** Lets the editor open a checkout the daemon made for a chat. */
  adoptCheckout?(checkout: CheckoutTarget): void;
  transcript?: NativeTranscriptActions;
  /** Request IDs of chat operations left unknown, kept across reloads and restarts. */
  requestIds?: RequestIds;
}) {
  let local = localResult.backend;
  let localRetry: Promise<void> | undefined;
  const sessions = new Map<string, ChatIpcSession>();
  /** Worktree creations for the current document; replacing the document cancels them. */
  const worktreeCreations = new Set<AbortController>();
  let documentId = randomUUID();
  const run = <A>(effect: Effect.Effect<A, ApplicationError>) =>
    runApplicationEffect(runtime, effect);
  const emitChat = (backendId: string) => (id: string, result: Reply) => {
    emit(backendId, id, result);
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
          },
        ),
      );
    // A remote host sets up its own providers; its folders are its approved roots, which a
    // chat names directly, so main grants nothing for it.
    if (remote && !sessions.has('remote'))
      sessions.set(
        'remote',
        new ChatIpcSession(
          runtime,
          remote.chat,
          { mode: 'remote', connection: remote.connection },
          remote.configuration.context,
          emitChat('remote'),
          {
            transcript,
            providers: bindProviderSetupClient(runtime, remote.providers, documentId),
          },
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
    ...(remote
      ? [
          {
            id: 'remote',
            label: remote.configuration.ssh.profile.label,
            mode: 'remote' as const,
            context: remote.configuration.context,
          },
        ]
      : []),
  ];
  /**
   * Sends under a request ID kept durably before it is sent, so a repeat after a lost reply, a
   * reload or a restart asks for the first outcome. The ID is kept only while the outcome is
   * unknown (`Uncertain`, or cancelled); an answer, a refusal included, is final.
   */
  const withRequestId = async <A>(
    key: string,
    send: (requestId: string) => Promise<A>,
  ): Promise<A> => {
    const requestId = requestIds.get(key) ?? randomUUID();
    requestIds.put(key, requestId);
    try {
      const output = await send(requestId);
      requestIds.delete(key);
      return output;
    } catch (error) {
      if (!ApplicationError.is(error) || !['Uncertain', 'Cancelled'].includes(error.code))
        requestIds.delete(key);
      throw error;
    }
  };
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
      // A remote host may be disconnected or unreachable; it drops an owner it hasn't heard
      // from in 30 minutes, so releasing it there is best effort.
      ...(remote ? [run(remote.providers.releaseOwner(owner)).catch(() => {})] : []),
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
    /**
     * Local chat's folders the native picker approved before, still the same directories, newest
     * first; or a remote host's approved roots and their folders, which it offers in place of a
     * picker for its disk.
     */
    async recentFolders(backendId = 'local') {
      if (backendId === 'remote') {
        if (!remote) return [];
        const { host } = remote.configuration.context;
        return (await run(remote.folders.listHostFolders({ host }))).folders;
      }
      if (!local) return [];
      return (await run(local.folders.listRecentFolders({ host: local.session.host }))).folders;
    },
    /**
     * Starts a new local chat's worktree from a folder local chat may use: the daemon derives its
     * location and makes it, and the editor may then open it. The daemon lets a chat use a worktree
     * of an approved checkout, so nothing more is approved here.
     */
    async createWorktree(root: string, branch: string) {
      const backend = requireBackend('New worktrees are unavailable.');
      const owner = documentId,
        creation = new AbortController();
      worktreeCreations.add(creation);
      const pending = JSON.stringify(['createChatWorktree', root, branch]);
      try {
        // An editor project is trusted natively; any other folder must be one the daemon approved.
        if (!isEditorFolder(root))
          await run(
            backend.folders.checkApprovedFolder({ host: backend.session.host, path: root }),
          );
        const created = await withRequestId(pending, (requestId) =>
          runApplicationEffect(
            runtime,
            backend.workspace.createChatWorktree({ installationId, requestId, root, branch }),
            { signal: creation.signal },
          ),
        );
        // A replaced document's worktree is left on disk but not offered to the new document.
        if (owner !== documentId)
          throw new ApplicationError({
            code: 'Cancelled',
            message: 'The window reloaded while the worktree was created.',
          });
        adoptCheckout(created);
        return created.root;
      } finally {
        worktreeCreations.delete(creation);
      }
    },
    /**
     * Opens a local chat without a project's folder as a project where it is, so nothing moves and
     * the agent keeps working in the same place, then lists the chat under that project. The daemon
     * does both steps as one operation.
     */
    async turnIntoProject(conversationId: string) {
      const backend = requireBackend('Turning a chat into a project is unavailable.');
      const owner = documentId;
      const created = await withRequestId(
        JSON.stringify(['turnChatIntoProject', conversationId]),
        (requestId) =>
          run(
            backend.workspace.turnChatIntoProject({
              installationId,
              requestId,
              target: { ...backend.session, conversationId },
            }),
          ),
      );
      if (owner !== documentId)
        throw new ApplicationError({
          code: 'Cancelled',
          message: 'The window reloaded while the project was opened.',
        });
      adoptCheckout(created);
      return created.root;
    },
    /** The local daemon's file host, finding or starting the daemon first. */
    async getLocalBackend() {
      await this.getContext('local');
      return local!;
    },
    /** The local daemon's workspace if local chat already reached it; never finds or starts one. */
    peekLocalWorkspace: () => local?.workspace ?? null,
    requireLocal(backendId: string) {
      if (backendId === 'local' && !local) throw localResult.error;
    },
    releaseDocument: releaseChatDocument,
  };
}
export type DesktopChatBackends = ReturnType<typeof createChatBackends>;
