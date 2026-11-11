import { runDaemon } from '../src/daemon.ts';
import { describeFailure } from '../src/failure.ts';
import { onShutdownSignal } from '../src/signals.ts';
import { createFauxProviders, readFauxScript } from './faux.ts';

/**
 * The daemon's test entry: `bun test/faux-daemon.ts <absolute data directory>`. It composes the
 * real daemon with faux providers and an in-memory credential key, scripted by `faux.json`.
 */
const [argument = '', ...rest] = process.argv.slice(2);
const directory = rest.length ? '' : argument;
const script = readFauxScript(directory);
await runDaemon({
  directory,
  signal: onShutdownSignal(),
  ready: (line) => console.log(line),
  closeClaudeCode: async () => {},
  local: () => createFauxProviders(directory),
  ...(script.idleMs ? { idleMs: script.idleMs } : {}),
  ...(script.pollMs ? { pollMs: script.pollMs } : {}),
}).catch((error) => {
  console.error(JSON.stringify({ event: 'failed', error: describeFailure(error) }));
  process.exitCode = 1;
});
