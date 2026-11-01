import { contextBridge, ipcRenderer } from "electron";
import { channels, unwrap, type ChatBridge, type Reply } from "./wire.ts";
const bridge: ChatBridge = {
  context: async () =>
    unwrap(await ipcRenderer.invoke(channels.call, { kind: "context" })) as never,
  call: (kind, operation, input, id) =>
    ipcRenderer.invoke(channels.call, { kind, operation, input, id }),
  cancel: (id) => ipcRenderer.send(channels.cancel, id),
  events: (receive) => {
    const f = (_: unknown, id: string, r: Reply) => receive(id, r);
    ipcRenderer.on(channels.event, f);
    return () => ipcRenderer.off(channels.event, f);
  },
  quit: (receive) => {
    const f = (_: unknown, id: string) => receive(id);
    ipcRenderer.on(channels.quit, f);
    return () => ipcRenderer.off(channels.quit, f);
  },
  consent: (id, preserved) => ipcRenderer.send(channels.consent, { id, preserved }),
  ready: () => ipcRenderer.send(channels.ready),
};
contextBridge.exposeInMainWorld("moonbaseChat", bridge);
