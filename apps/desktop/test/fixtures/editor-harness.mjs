// Test-only Electron entry. It sees each IPC request main serves (main's `moonbaseTestIpc` hook,
// unpackaged builds only) and can delay or replace its outcome, never workspace effects.
import { app } from 'electron';
import { writeFileSync } from 'node:fs';
import { installFauxDaemon } from './faux-daemon.mjs';
// Local chat runs in the faux daemon, never the real one or the Keychain.
installFauxDaemon();
const control = {
  startupFailure: process.env.MOONBASE_TEST_STARTUP_FAILURE ?? null,
  /** Every request main received: its procedure, payload and sequence number. */
  calls: [],
  /** The sequence numbers of requests running now, to the requests. */
  active: new Map(),
  /** Sequence numbers of requests cancelled before they settled, as by their document going. */
  interrupted: [],
  sequence: 0,
  results: [],
  fault: null,
  outage: null,
  restoreOn: null,
  held: null,
  released: null,
  release() {
    this.released?.();
    this.released = null;
  },
};
globalThis.desktopTest = control;
// A failure as the procedure declares it, encoded; main decodes it with the procedure's schema.
const failure = (error) => ({ ok: false, error });
globalThis.moonbaseTestIpc = async (request, proceed) => {
  const { tag, payload } = request;
  const seq = control.sequence++;
  const seen = { tag, payload: structuredClone(payload), seq };
  control.calls.push(seen);
  if (control.startupFailure === 'chat-context' && tag === 'getChatContext')
    return failure({ _tag: 'LocalDaemonError', reason: 'unreachable' });
  if (control.startupFailure === 'editor' && tag === 'loadRecovery')
    return failure({
      _tag: 'WorkspaceStoreError',
      failure: 'publication',
      detail: 'Controlled editor recovery initialization failure',
    });
  if (control.restoreOn === tag) {
    control.outage = null;
    control.restoreOn = null;
  }
  if (control.outage === tag) return failure({ _tag: 'HostUnavailableError', reason: 'closed' });
  control.active.set(seq, seen);
  let reply;
  try {
    reply = await proceed();
  } finally {
    control.active.delete(seq);
  }
  if (reply.interrupted) control.interrupted.push(seq);
  control.results.push({ operation: tag, reply: { ok: reply.ok, value: reply.value } });
  if (control.held === tag) {
    control.held = 'waiting';
    await new Promise((resolve) => {
      control.released = resolve;
    });
  }
  if (control.fault === tag && reply.ok) {
    control.fault = null;
    return failure({ _tag: 'UncertainError', operation: tag });
  }
  return reply;
};
app.on('will-quit', () => {
  if (process.env.MOONBASE_TEST_REPORT)
    writeFileSync(
      process.env.MOONBASE_TEST_REPORT,
      JSON.stringify({ resources: process.getActiveResourcesInfo(), active: control.active.size }),
    );
});
if (process.env.MOONBASE_TEST_QUIT_EARLY)
  app.on('browser-window-created', () => queueMicrotask(() => app.quit()));
// Never probe or use the developer's own Claude Code login.
process.env.PI_CLAUDE_CODE_COMMAND ??= '/nonexistent/claude';
await import(process.env.MOONBASE_TEST_MAIN ?? '../../dist/main.mjs');
