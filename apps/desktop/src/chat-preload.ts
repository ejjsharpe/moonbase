import { contextBridge, ipcRenderer } from 'electron';
import { channels, unwrap, type ChatBridge, type Reply } from './chat/wire.ts';

// The reviewed bridge uses separate channels; the main process still authenticates every request.
const active = new Map<string, string>();
const bridge: ChatBridge = {
  targets: async () =>
    unwrap(await ipcRenderer.invoke(channels.call, { kind: 'targets' })) as never,
  chooseFolder: async () =>
    unwrap(
      await ipcRenderer.invoke(channels.call, { kind: 'choose-folder', backendId: 'local' }),
    ) as never,
  recentFolders: async (backendId = 'local') =>
    unwrap(await ipcRenderer.invoke(channels.call, { kind: 'recent-folders', backendId })) as never,
  createWorktree: async (root, branch) =>
    unwrap(
      await ipcRenderer.invoke(channels.call, {
        kind: 'create-worktree',
        backendId: 'local',
        root,
        branch,
      }),
    ) as never,
  turnIntoProject: async (conversationId) =>
    unwrap(
      await ipcRenderer.invoke(channels.call, {
        kind: 'turn-into-project',
        backendId: 'local',
        conversationId,
      }),
    ) as never,
  context: async (backendId = 'remote') =>
    unwrap(await ipcRenderer.invoke(channels.call, { kind: 'context', backendId })) as never,
  async call(kind, operation, input, id, backendId = 'remote') {
    active.set(id, backendId);
    try {
      const reply: Reply = await ipcRenderer.invoke(channels.call, {
        kind,
        operation,
        input,
        id,
        backendId,
      });
      if ((kind !== 'watch-chat' && kind !== 'watch-connection') || !reply.ok) active.delete(id);
      return reply;
    } catch (error) {
      active.delete(id);
      throw error;
    }
  },
  async cancel(id, backendId = 'remote') {
    try {
      return await ipcRenderer.invoke(channels.cancel, { id, backendId });
    } finally {
      active.delete(id);
    }
  },
  events(receive) {
    const listener = (_: unknown, id: string, result: Reply, backendId: string) =>
      receive(id, result, backendId);
    ipcRenderer.on(channels.event, listener);
    return () => ipcRenderer.off(channels.event, listener);
  },
};
// A committed document unload releases waits/observations, never remote execution.
window.addEventListener('unload', () => {
  for (const [id, backendId] of active) void bridge.cancel(id, backendId).catch(() => {});
  active.clear();
});
contextBridge.exposeInMainWorld('moonbaseChat', bridge);
