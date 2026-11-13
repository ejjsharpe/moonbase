// Package builds ignore -r. Install controlled capabilities at the initial debugger pause.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const executable = fileURLToPath(
  new URL(
    `../../release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Moonbase.app/Contents/MacOS/Moonbase`,
    import.meta.url,
  ),
);
const child = spawn(
  executable,
  [
    '--inspect-brk=0',
    ...process.argv
      .slice(2)
      .filter((argument) => !argument.startsWith('--inspect') && argument !== '-r'),
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
child.stdout.pipe(process.stdout);
const lines = createInterface({ input: child.stderr });
let injected = false;
const deadline = setTimeout(() => fail(Error('Packaged pre-main injection did not settle')), 10000);
function fail(error) {
  console.error(error);
  child.kill('SIGKILL');
  process.exitCode = 1;
}
async function inject(url) {
  const source = await readFile(new URL('./integrated-harness.cjs', import.meta.url), 'utf8');
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map(),
    paused = Promise.withResolvers();
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request.reject(Error(message.error.message));
      else request.resolve(message.result);
    }
  });
  await call('Debugger.enable');
  const { breakpointId } = await call('Debugger.setBreakpointByUrl', {
    lineNumber: 0,
    urlRegex: 'app\\.asar/main\\.mjs$',
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method !== 'Debugger.paused') return;
    if (message.params.hitBreakpoints?.includes(breakpointId))
      paused.resolve(message.params.callFrames[0]);
    else void call('Debugger.resume').catch(paused.reject);
  });
  await call('Runtime.runIfWaitingForDebugger');
  const frame = await paused.promise;
  const result = await call('Debugger.evaluateOnCallFrame', {
    callFrameId: frame.callFrameId,
    expression: `(function(require){${source}\n})(process.getBuiltinModule('module').createRequire(process.execPath))`,
  });
  if (result.exceptionDetails)
    throw Error(
      result.exceptionDetails.exception?.description ?? 'Packaged pre-main injection failed',
    );
  await call('Debugger.removeBreakpoint', { breakpointId });
  await call('Debugger.resume');
  socket.close();
  clearTimeout(deadline);
}
lines.on('line', (line) => {
  const match = /Debugger listening on (ws:\/\/\S+)/.exec(line);
  if (match && !injected) {
    injected = true;
    void inject(match[1]).then(() => process.stderr.write(line + '\n'), fail);
  } else process.stderr.write(line + '\n');
});
child.once('error', fail);
child.once('exit', (code, signal) => {
  clearTimeout(deadline);
  process.exitCode = code ?? (signal ? 1 : 0);
});
