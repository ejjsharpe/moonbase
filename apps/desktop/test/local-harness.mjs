// Controlled desktop qualification only; this entry never reaches shipped builds.
import { ipcMain, safeStorage, clipboard } from 'electron';
import { createCipheriv, createDecipheriv } from 'node:crypto';
const key = Buffer.alloc(32, 7);
// No controlled fixture may accidentally write the user's OS clipboard.
globalThis.moonbaseTestClipboard = [];
globalThis.moonbaseTestClipboardWrite = async (text) => {
  globalThis.moonbaseTestClipboard.push(text);
};
clipboard.writeText = globalThis.moonbaseTestClipboardWrite;
safeStorage.isAsyncEncryptionAvailable = async () => true;
safeStorage.encryptStringAsync = async (plain) => {
  const cipher = createCipheriv('aes-256-gcm', key, Buffer.alloc(12, 1));
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
};
safeStorage.decryptStringAsync = async (bytes) => {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.alloc(12, 1));
  decipher.setAuthTag(bytes.subarray(-16));
  return {
    result: Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString(),
    shouldReEncrypt: false,
  };
};
const fetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  if (process.env.MOONBASE_TEST_ALLOW_LOOPBACK && new URL(String(args[0])).hostname === '127.0.0.1')
    return fetch(...args);
  throw Error('Provider network access is disabled in this fixture.');
};
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
await import(process.env.MOONBASE_TEST_MAIN);
