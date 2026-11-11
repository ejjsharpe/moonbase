// Controlled desktop qualification only; this entry never reaches shipped builds.
import { ipcMain, clipboard } from 'electron';
import { installFauxDaemon } from './faux-daemon.mjs';
// Local chat runs in the faux daemon: faux providers, an in-memory credential key and provider
// network refused. Main reaches it only over loopback.
installFauxDaemon();
// No controlled fixture may accidentally write the user's OS clipboard.
globalThis.moonbaseTestClipboard = [];
globalThis.moonbaseTestClipboardWrite = async (text) => {
  globalThis.moonbaseTestClipboard.push(text);
};
clipboard.writeText = globalThis.moonbaseTestClipboardWrite;
const fetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  if (new URL(String(args[0])).hostname === '127.0.0.1') return fetch(...args);
  throw Error('Provider network access is disabled in this fixture.');
};
// Counts the renderer's chat reads, so a test can show live updates arrive without polling.
globalThis.desktopChatReads = 0;
{
  const register = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (name, listener) =>
    register(name, (event, input) => {
      if (name === 'moonbase-chat:call' && input?.kind === 'chat' && input.operation === 'getChat')
        globalThis.desktopChatReads++;
      return listener(event, input);
    });
}
if (process.env.MOONBASE_TEST_STARTUP_FAILURE === 'editor') {
  const register = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (name, listener) =>
    register(name, (event, input) => {
      if (name === 'moonbase:call' && input?.input?.operation === 'loadRecovery')
        return { ok: false, error: { code: 'Persistence', message: 'Controlled startup failure' } };
      return listener(event, input);
    });
}
// Never probe or use the developer's own Claude Code login.
process.env.PI_CLAUDE_CODE_COMMAND ??= '/nonexistent/claude';
await import(process.env.MOONBASE_TEST_MAIN ?? '../dist/main.mjs');
