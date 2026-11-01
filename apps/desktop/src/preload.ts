import "./chat-preload.ts";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { channels, type DesktopBridge, type DesktopAction, type Reply } from "./wire.ts";
const active = new Set<string>();
const call = async <T = unknown>(method: string, input: unknown, id: string) => {
  active.add(id);
  try {
    const reply: Reply<T> = await ipcRenderer.invoke(channels.call, { method, input, id });
    if (method !== "watch" || !reply.ok) active.delete(id);
    return reply;
  } catch (error) { active.delete(id); throw error; }
};
window.addEventListener("unload", () => {
  for (const id of active) ipcRenderer.send(channels.cancel, id);
  active.clear();
});
const bridge: DesktopBridge = {
  clientId: "desktop-primary",
  call(method, input, id) {
    if (!["command", "choose-checkout", "choose-imports", "clipboard-imports", "watch"].includes(method)) return Promise.reject(Error("Unsupported bridge method."));
    return call(method, input, id);
  },
  cancel: id => { active.delete(id); ipcRenderer.send(channels.cancel, id); },
  events(receive) { const listener = (_: unknown, id: string, result: Reply) => receive(id, result); ipcRenderer.on(channels.event, listener); return () => ipcRenderer.removeListener(channels.event, listener); },
  actions(receive) { const listener = (_: unknown, action: DesktopAction, id: string) => receive(action, id); ipcRenderer.on(channels.action, listener); return () => ipcRenderer.removeListener(channels.action, listener); },
  chatConfigured: () => ipcRenderer.invoke(channels.configured, null),
  ready: () => ipcRenderer.send(channels.ready),
  quitResult: (id, consent) => ipcRenderer.send(channels.quit, { id, consent }),
  drop: (checkout, files) => call<string[]>("dropped-imports", { checkout, paths: files.map(file => webUtils.getPathForFile(file)).filter(Boolean) }, crypto.randomUUID()),
};
// No ipcRenderer/event objects, filesystem functions or generic channel access cross this boundary.
contextBridge.exposeInMainWorld("moonbase", bridge);
