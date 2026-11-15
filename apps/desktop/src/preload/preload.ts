import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  ipcChannels,
  ipcPortMessage,
  isIpcNonce,
  type DesktopBridge,
} from '../ipc/desktop-bridge.ts';

// The preload only hands the renderer IPC ports: main answers each connect request with one, in
// order, and every request then travels over it as Effect RPC. No ipcRenderer, event objects,
// filesystem functions or generic channel access cross this boundary.
const waiting: string[] = [];
ipcRenderer.on(ipcChannels.port, (event) => {
  const nonce = waiting.shift();
  if (nonce && event.ports.length === 1)
    window.postMessage({ type: ipcPortMessage, nonce }, '/', [...event.ports]);
  else for (const port of event.ports) port.close();
});
const bridge: DesktopBridge = {
  async connect(nonce) {
    if (!isIpcNonce(nonce)) throw Error('Invalid IPC connection request.');
    waiting.push(nonce);
    try {
      await ipcRenderer.invoke(ipcChannels.connect);
    } catch (error) {
      waiting.splice(waiting.indexOf(nonce), 1);
      throw error;
    }
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
};
contextBridge.exposeInMainWorld('moonbase', bridge);
