import { contextBridge, ipcRenderer, webUtils } from "electron";
import { channels, type DesktopBridge, type DesktopAction, type Reply } from "./wire.ts";
const call = (method: string, input: unknown, id: string) => ipcRenderer.invoke(channels.call, { method, input, id });
const bridge: DesktopBridge = {
  clientId: "desktop-primary",
  call(method, input, id) {
    if (!["command", "choose-checkout", "choose-imports", "clipboard-imports", "watch"].includes(method)) return Promise.reject(Error("Unsupported bridge method."));
    return call(method, input, id);
  },
  cancel: id => ipcRenderer.send(channels.cancel, id),
  events(receive) { const listener = (_: unknown, id: string, result: Reply) => receive(id, result); ipcRenderer.on(channels.event, listener); return () => ipcRenderer.removeListener(channels.event, listener); },
  actions(receive) { const listener = (_: unknown, action: DesktopAction, id: string) => receive(action, id); ipcRenderer.on(channels.action, listener); return () => ipcRenderer.removeListener(channels.action, listener); },
  quitResult: (id, consent) => ipcRenderer.send(channels.quit, { id, consent }),
  drop: (checkout, files) => call("dropped-imports", { checkout, paths: files.map(file => webUtils.getPathForFile(file)).filter(Boolean) }, crypto.randomUUID()),
};
// No ipcRenderer/event objects, filesystem functions or generic channel access cross this boundary.
contextBridge.exposeInMainWorld("moonbase", bridge);
