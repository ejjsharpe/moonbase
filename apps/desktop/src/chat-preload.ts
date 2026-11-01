import { contextBridge, ipcRenderer } from "electron";
import { channels, unwrap, type ChatBridge, type Reply } from "@moonbase/chat-probe/bridge";

// The reviewed bridge uses separate channels; the main process still authenticates every request.
const active = new Set<string>();
const bridge: ChatBridge = {
  context: async () =>
    unwrap(await ipcRenderer.invoke(channels.call, { kind: "context" })) as never,
  async call(kind, operation, input, id) {
    active.add(id);
    try {
      const reply: Reply = await ipcRenderer.invoke(channels.call, { kind, operation, input, id });
      if (!kind.startsWith("watch-") || !reply.ok) active.delete(id);
      return reply;
    } catch (error) { active.delete(id); throw error; }
  },
  cancel(id) { active.delete(id); ipcRenderer.send(channels.cancel, id); },
  events(receive) {
    const listener = (_: unknown, id: string, result: Reply) => receive(id, result);
    ipcRenderer.on(channels.event, listener);
    return () => ipcRenderer.off(channels.event, listener);
  },
  // Desktop Quit is coordinated with the editor gate, never the standalone chat handshake.
  quit: () => () => {},
  consent: () => {},
  ready: () => {},
};
// A committed document unload releases waits/observations, never remote execution.
window.addEventListener("unload", () => { for (const id of active) ipcRenderer.send(channels.cancel, id); active.clear(); });
contextBridge.exposeInMainWorld("moonbaseChat", bridge);
