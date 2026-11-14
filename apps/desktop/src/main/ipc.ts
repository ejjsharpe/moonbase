import type { BrowserWindow, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { EditorSession } from './session.ts';
import type { DesktopChatBackends } from './chat-backends.ts';
import type { WindowLifecycle } from './window-lifecycle.ts';
import { channels, errorDTO, keys, record } from '../ipc/wire.ts';
import {
  channels as chatChannels,
  record as chatRecord,
  fields,
  errorReply,
  requestId,
} from '../ipc/chat-wire.ts';

export function createTrustedDocumentGuard(window: BrowserWindow, appURL: string) {
  return (event: IpcMainEvent | IpcMainInvokeEvent) => {
    if (
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== appURL
    )
      throw new ApplicationError({
        code: 'Unauthorized',
        message: 'Untrusted renderer frame/document.',
      });
  };
}

export function installCommandIpc({
  ipcMain,
  requireTrusted,
  editorSession,
  chatBackends,
  lifecycle,
}: {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>;
  requireTrusted(event: IpcMainInvokeEvent): void;
  editorSession: Pick<EditorSession, 'call' | 'cancel'>;
  chatBackends: Pick<
    DesktopChatBackends,
    | 'getTargets'
    | 'getContext'
    | 'chooseFolder'
    | 'recentFolders'
    | 'createWorktree'
    | 'turnIntoProject'
    | 'getSession'
  >;
  lifecycle: Pick<WindowLifecycle, 'reportCleanup' | 'isQuitting'>;
}) {
  const { reportCleanup } = lifecycle;
  ipcMain.handle(channels.call, async (event, value: unknown) => {
    try {
      requireTrusted(event);
      const v = record(value);
      keys(v, ['method', 'input', 'id']);
      return await editorSession.call(v.method, v.input, v.id);
    } catch (error) {
      return { ok: false, error: errorDTO(error) };
    }
  });
  ipcMain.handle(channels.cancel, async (event, id: unknown) => {
    try {
      requireTrusted(event);
      const reply = await editorSession.cancel(id);
      if (!reply.ok) reportCleanup(Promise.reject(new ApplicationError(reply.error)));
      return reply;
    } catch (e) {
      return { ok: false, error: errorDTO(e) };
    }
  });
  ipcMain.handle(channels.configured, (event, ...args: unknown[]) => {
    try {
      requireTrusted(event);
      if (args.length !== 1 || args[0] !== null)
        throw new ApplicationError({
          code: 'InvalidInput',
          message: 'Unexpected configuration query input.',
        });
      return { ok: true, value: true };
    } catch (error) {
      return { ok: false, error: errorDTO(error) };
    }
  });
  ipcMain.handle(chatChannels.call, async (event, value: unknown) => {
    try {
      requireTrusted(event);
      const v = chatRecord(value);
      if (v.kind === 'targets') {
        fields(v, ['kind']);
        return { ok: true, value: chatBackends.getTargets() };
      }
      if (
        typeof v.backendId !== 'string' ||
        !chatBackends.getTargets().some((target) => target.id === v.backendId)
      )
        throw new ApplicationError({
          code: 'Unauthorized',
          message: 'Choose an installed chat target.',
        });
      const backendId = v.backendId;
      if (v.kind === 'context') {
        fields(v, ['kind', 'backendId']);
        return { ok: true, value: await chatBackends.getContext(backendId) };
      }
      if (v.kind === 'choose-folder') {
        fields(v, ['kind', 'backendId']);
        if (backendId !== 'local' || lifecycle.isQuitting())
          throw new ApplicationError({
            code: 'Unavailable',
            message: 'Folder selection is unavailable.',
          });
        return { ok: true, value: await chatBackends.chooseFolder() };
      }
      if (v.kind === 'recent-folders') {
        fields(v, ['kind', 'backendId']);
        return { ok: true, value: await chatBackends.recentFolders(backendId) };
      }
      if (v.kind === 'turn-into-project') {
        fields(v, ['kind', 'backendId', 'conversationId']);
        if (backendId !== 'local' || lifecycle.isQuitting())
          throw new ApplicationError({
            code: 'Unavailable',
            message: 'Turning a chat into a project is unavailable.',
          });
        if (
          typeof v.conversationId !== 'string' ||
          !v.conversationId ||
          v.conversationId.length > 512
        )
          throw new ApplicationError({ code: 'InvalidInput', message: 'Choose a local chat.' });
        return { ok: true, value: await chatBackends.turnIntoProject(v.conversationId) };
      }
      if (v.kind === 'create-worktree') {
        fields(v, ['kind', 'backendId', 'root', 'branch', 'requestId']);
        if (backendId !== 'local' || lifecycle.isQuitting())
          throw new ApplicationError({
            code: 'Unavailable',
            message: 'New worktrees are unavailable.',
          });
        if (typeof v.root !== 'string' || typeof v.branch !== 'string')
          throw new ApplicationError({
            code: 'InvalidInput',
            message: 'Choose a folder and branch for the worktree.',
          });
        requestId(v.requestId);
        return {
          ok: true,
          value: await chatBackends.createWorktree(v.root, v.branch, v.requestId),
        };
      }
      fields(v, ['kind', 'operation', 'input', 'id', 'backendId']);
      const owner = chatBackends.getSession(backendId);
      if (!owner)
        throw new ApplicationError({
          code: 'Unavailable',
          message: 'This chat target is unavailable.',
        });
      return await owner.call(v.kind, v.operation, v.input, v.id);
    } catch (error) {
      return errorReply(error);
    }
  });
  ipcMain.handle(chatChannels.cancel, async (event, value: unknown) => {
    try {
      requireTrusted(event);
      const v = chatRecord(value);
      fields(v, ['id', 'backendId']);
      const owner =
        typeof v.backendId === 'string' ? chatBackends.getSession(v.backendId) : undefined;
      if (!owner)
        throw new ApplicationError({ code: 'Unauthorized', message: 'Unknown chat backend.' });
      const reply = await owner.cancel(v.id);
      if (!reply.ok) reportCleanup(Promise.reject(new ApplicationError(reply.error)));
      return reply;
    } catch (error) {
      return errorReply(error);
    }
  });

  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    for (const channel of [
      channels.call,
      channels.cancel,
      channels.configured,
      chatChannels.call,
      chatChannels.cancel,
    ])
      ipcMain.removeHandler(channel);
  };
}
