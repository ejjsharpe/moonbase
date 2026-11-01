// Test-only Electron entry. Public ipcMain registration wraps delivery, never workspace effects.
import { app, ipcMain } from 'electron';
import { writeFileSync } from 'node:fs';
const register = ipcMain.handle.bind(ipcMain);
const control = { calls: [], chatCalls: [], cancelIds: [], chatCancelIds: [], results: [], fault: null, noStatus: false, outage: null, restoreOn: null, held: null, released: null, release() { this.released?.(); this.released = null; }, cancels: 0 };
globalThis.desktopTest = control;
ipcMain.on('moonbase:cancel', (_event, id) => { control.cancels++; control.cancelIds.push(id); });
ipcMain.on('moonbase-chat:cancel', (_event, id) => control.chatCancelIds.push(id));
ipcMain.handle = (name, listener) => register(name, async (event, input) => {
  if (name === 'moonbase-chat:call') control.chatCalls.push(structuredClone(input));
  if (name !== 'moonbase:call') return listener(event, input);
  control.calls.push(structuredClone(input));
  if (control.restoreOn === input?.input?.operation) { control.outage = null; control.restoreOn = null; }
  if (control.outage === input?.input?.operation) return { ok: false, error: { code: 'Unavailable', message: 'Controlled observation transport outage' } };
  const reply = await listener(event, input);
  const operation = input?.input?.operation; control.results.push({ operation, reply: structuredClone(reply) });
  if (control.held === operation) { control.held = 'waiting'; await new Promise(resolve => { control.released = resolve; }); }
  if ((control.fault === operation || control.fault === "final-publication" && operation === "persistRecovery" && input.input.input.state.drafts.length === 0) && reply.ok) { if (control.fault === "final-publication") control.noStatus = true; control.fault = null; return { ok: false, error: { code: 'Uncertain', message: 'Controlled committed reply loss' } }; }
  if (control.noStatus && operation === "getRecoveryPublication") return { ok: false, error: { code: "Unavailable", message: "Controlled exact-status outage" } };
  return reply;
});
app.on('will-quit', () => { if (process.env.MOONBASE_TEST_REPORT) writeFileSync(process.env.MOONBASE_TEST_REPORT, JSON.stringify({ resources: process.getActiveResourcesInfo(), cancels: control.cancels, cancelListeners: ipcMain.listenerCount('moonbase:cancel'), chatCancelListeners: ipcMain.listenerCount('moonbase-chat:cancel') })); });
if (process.env.MOONBASE_TEST_QUIT_EARLY) app.on('browser-window-created', () => queueMicrotask(() => app.quit()));
await import('../dist/main.mjs');
