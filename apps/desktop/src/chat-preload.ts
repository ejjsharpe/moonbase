import { contextBridge, ipcRenderer } from "electron";
import { channels, unwrap, type ChatBridge, type Reply } from "@moonbase/chat-probe/bridge";

// The reviewed bridge uses separate channels; the main process still authenticates every request.
const bridge: ChatBridge = {
  context: async () => unwrap(await ipcRenderer.invoke(channels.call, { kind: "context" })) as never,
  call: (kind, operation, input, id) => ipcRenderer.invoke(channels.call, { kind, operation, input, id }),
  cancel: id => ipcRenderer.send(channels.cancel, id),
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
contextBridge.exposeInMainWorld("moonbaseChat", bridge);
