import type { NativeTranscriptActions } from '../chat/transcript-native.ts';
import { randomUUID } from 'node:crypto';
import type { ManagedRuntime } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { ChatClient } from '@moonbase/contracts/chat';
import type { ConnectionClient } from '@moonbase/contracts/connection';
import { bindChatClient, bindProviderSetupClient } from '@moonbase/application/runtime/clients';
import { runApplicationEffect } from '@moonbase/application/runtime/effect-client';
import type { acquireLocalChat } from '../chat/local.ts';
import type { ChatConfiguration } from '../chat/config.ts';
import { ChatIpcSession } from '../chat/session.ts';
import type { Reply, DesktopChatTarget } from '../chat/wire.ts';

type LocalResult = {
  backend: Awaited<ReturnType<typeof acquireLocalChat>> | null;
  error: ApplicationError | null;
};

export function createChatBackends({
  runtime,
  localResult,
  acquireLocal,
  chatConfiguration,
  remoteChat,
  connection,
  emit,
  pickFolder,
  createWorktree,
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
  /** Creates a linked worktree of the checkout at `root`, returning its root. */
  createWorktree?(root: string, branch: string, signal: AbortSignal): Promise<string>;
  transcript?: NativeTranscriptActions;
}) {
  let local = localResult.backend;
  let localRetry: Promise<void> | undefined;
  const sessions = new Map<string, ChatIpcSession>();
  /** Worktree creations for the current document; replacing the document cancels them. */
  const worktreeCreations = new Set<AbortController>();
  let documentId = randomUUID();
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
          null,
          local.session,
          emitChat('local'),
          {
            transcript,
            providers: bindProviderSetupClient(runtime, local.providers, documentId),
          },
        ),
      );
    if (chatConfiguration && remoteChat && connection && !sessions.has('remote'))
      sessions.set(
        'remote',
        new ChatIpcSession(
          runtime,
          remoteChat,
          connection,
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
  const releaseChatDocument = async () => {
    const owner = documentId;
    for (const creation of worktreeCreations) creation.abort();
    worktreeCreations.clear();
    const closing = [...sessions.values()].map((session) => session.dispose());
    sessions.clear();
    documentId = randomUUID();
    local?.control.setAdmissionsOpen(true);
    installChatSessions();
    const results = await Promise.allSettled([
      ...closing,
      ...(local ? [runApplicationEffect(runtime, local.providers.releaseOwner(owner))] : []),
    ]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  };

  return {
    getTargets: () => targets,
    hasLocalChat: () => local !== null,
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
      if (!local)
        throw new ApplicationError({
          code: 'Unavailable',
          message: 'Folder selection is unavailable.',
        });
      const owner = documentId;
      const selection = await pickFolder();
      if (owner !== documentId || !selection) return null;
      return local.approveFolder(selection);
    },
    /**
     * Starts a new local chat's worktree from a folder local chat may use, and approves the new
     * worktree as that chat's working folder.
     */
    async createWorktree(root: string, branch: string) {
      if (!local || !createWorktree)
        throw new ApplicationError({
          code: 'Unavailable',
          message: 'New worktrees are unavailable.',
        });
      const owner = documentId,
        creation = new AbortController();
      worktreeCreations.add(creation);
      try {
        await local.requireApprovedFolder(root);
        const created = await createWorktree(root, branch, creation.signal);
        // A replaced document's worktree is left on disk but not approved for the new document.
        if (owner !== documentId)
          throw new ApplicationError({
            code: 'Cancelled',
            message: 'The window reloaded while the worktree was created.',
          });
        return await local.approveFolder(created);
      } finally {
        worktreeCreations.delete(creation);
      }
    },
    requireLocal(backendId: string) {
      if (backendId === 'local' && !local) throw localResult.error;
    },
    setAdmissionsOpen(open: boolean) {
      local?.control.setAdmissionsOpen(open);
    },
    hasActiveWork: () =>
      local ? runApplicationEffect(runtime, local.control.hasActiveWork()) : Promise.resolve(false),
    releaseDocument: releaseChatDocument,
  };
}
export type DesktopChatBackends = ReturnType<typeof createChatBackends>;
