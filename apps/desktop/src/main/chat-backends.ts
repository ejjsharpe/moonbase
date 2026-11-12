import type { NativeTranscriptActions } from '../chat/transcript-native.ts';
import { randomUUID } from 'node:crypto';
import type { Effect, ManagedRuntime } from 'effect';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { ChatClient } from '@moonbase/contracts/chat';
import type { ConnectionClient } from '@moonbase/contracts/connection';
import { bindChatClient, bindProviderSetupClient } from '@moonbase/application/runtime/clients';
import { runApplicationEffect } from '@moonbase/application/runtime/effect-client';
import type { DaemonChat, LocalDaemonClient } from '../chat/daemon.ts';
import type { ChatConfiguration } from '../chat/config.ts';
import { ChatIpcSession } from '../chat/session.ts';
import type { Reply, DesktopChatTarget } from '../chat/wire.ts';
import type { RequestIds } from './request-ids.ts';

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
  local,
  remote = null,
  emit,
  pickFolder,
  installationId,
  adoptCheckout = () => {},
  transcript,
  requestIds,
}: {
  runtime: ManagedRuntime.ManagedRuntime<never, ApplicationError>;
  /** The local daemon, found or started on demand; local chat is installed once it is reached. */
  local: Pick<LocalDaemonClient, 'get' | 'peek'>;
  remote?: RemoteChat | null;
  emit(backendId: string, id: string, result: Reply): void;
  pickFolder(): Promise<string | null>;
  /** The identity this profile's workspace store has to the daemon. */
  installationId: string;
  /** Lets the editor open a checkout the daemon made for a chat. */
  adoptCheckout?(checkout: CheckoutTarget): void;
  transcript?: NativeTranscriptActions;
  /** Request IDs of chat operations left unknown, kept across reloads and restarts. */
  requestIds: RequestIds;
}) {
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
    const backend = local.peek();
    if (backend && !sessions.has('local'))
      sessions.set(
        'local',
        new ChatIpcSession(
          runtime,
          bindChatClient(runtime, backend.chat),
          { mode: 'local' },
          backend.session,
          emitChat('local'),
          {
            transcript,
            providers: bindProviderSetupClient(runtime, backend.providers, documentId),
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
    { id: 'local', label: 'Local', mode: 'local' },
    ...(remote
      ? [{ id: 'remote', label: remote.configuration.ssh.profile.label, mode: 'remote' as const }]
      : []),
  ];
  /**
   * Sends under a request ID kept durably before it is sent, so a repeat after a lost reply, a
   * reload or a restart asks for the first outcome. The ID is kept only while the outcome is
   * unknown (`Uncertain`, or cancelled); an answer, a refusal included, is final.
   */
  const withRequestId = async <A>(key: string, send: (requestId: string) => Promise<A>) => {
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
  /** The local daemon's clients, finding or starting it, with local chat installed. */
  const reachLocal = async (): Promise<DaemonChat> => {
    const backend = await local.get();
    installChatSessions();
    return backend;
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
      ...(local.peek() ? [run(local.peek()!.providers.releaseOwner(owner))] : []),
      // A remote host may be disconnected or unreachable; it drops an owner it hasn't heard
      // from in 30 minutes, so releasing it there is best effort.
      ...(remote ? [run(remote.providers.releaseOwner(owner)).catch(() => {})] : []),
    ]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  };

  return {
    getTargets: () => targets,
    getSession: (backendId: string) => {
      // The daemon may have been reached for files before local chat asked for it.
      installChatSessions();
      return sessions.get(backendId);
    },
    getSessions: (): Pick<ChatIpcSession, 'dispose'>[] => [...sessions.values()],
    findTranscriptImage: (token: string) =>
      [...sessions.values()].map((session) => session.findImage(token)).find(Boolean),
    async getContext(backendId: string) {
      if (backendId === 'local') return (await reachLocal()).session;
      return remote!.configuration.context;
    },
    async chooseFolder() {
      const owner = documentId;
      const backend = await reachLocal();
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
      const backend = local.peek();
      if (!backend) return [];
      return (await run(backend.folders.listRecentFolders({ host: backend.session.host }))).folders;
    },
    /**
     * Starts a new local chat's worktree from a folder the daemon lets local chat use: it derives
     * the location and makes the worktree, which it opens as a checkout, so the chat may use it and
     * the editor may then open it. `requestId` is the renderer's for this new chat's send in a
     * worktree, kept until it learns the outcome, so a repeat after a lost reply gets the first
     * worktree and another chat never does.
     */
    async createWorktree(root: string, branch: string, requestId: string) {
      const owner = documentId,
        creation = new AbortController();
      worktreeCreations.add(creation);
      try {
        const backend = await reachLocal();
        await run(backend.folders.checkApprovedFolder({ host: backend.session.host, path: root }));
        const created = await runApplicationEffect(
          runtime,
          backend.workspace.createChatWorktree({ installationId, requestId, root, branch }),
          { signal: creation.signal },
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
      const owner = documentId;
      const backend = await reachLocal();
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
    releaseDocument: releaseChatDocument,
  };
}
export type DesktopChatBackends = ReturnType<typeof createChatBackends>;
