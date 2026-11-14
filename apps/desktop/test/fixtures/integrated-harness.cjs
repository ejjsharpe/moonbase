// Loaded with Electron -r before the unchanged built/archive main entry.
const { app, BrowserWindow, clipboard, ipcMain } = require('electron');
// From source, local chat runs in the faux daemon; a package runs its own daemon on a key file.
if (typeof __dirname === 'string' && !app.isPackaged)
  require(require('node:path').join(__dirname, 'faux-daemon.mjs')).installFauxDaemon();
const control = (globalThis.integratedTranscript = {
  calls: [],
  copied: [],
  beforeMain: !app.isReady() && BrowserWindow.getAllWindows().length === 0,
});
clipboard.writeText = async (text) => {
  control.copied.push(text);
};
clipboard.read = async () => {
  throw Error('OS clipboard access is disabled');
};
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (name, listener) =>
  register(name, async (event, input) => {
    if (name === 'moonbase-chat:call')
      control.calls.push({ kind: input.kind, operation: input.operation, backend: input.backend });
    return listener(event, input);
  });
// Main reaches only loopback: the local daemon and SSH forwards to remote hosts.
const fetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === '127.0.0.1') return fetch(input, options);
  throw Error('Provider network is disabled');
};
