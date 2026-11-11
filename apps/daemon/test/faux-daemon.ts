import { createKeyFileSource } from '@moonbase/chat-runtime/credentials';
import { runDaemon } from '../src/daemon.ts';
import { readDirectoryArgument } from '../src/data-directory.ts';
import { describeFailure } from '../src/failure.ts';
import { onShutdownSignal } from '../src/signals.ts';
import { createFauxProviders, readFauxScript } from './faux.ts';

/**
 * The daemon's test entry: `bun test/faux-daemon.ts <absolute data directory>`. It composes the
 * real daemon with faux providers, scripted by `faux.json`, and an in-memory credential key, or the
 * temporary key file `daemon.json` names, so sign-ins survive a restart.
 */
try {
  const directory = readDirectoryArgument(process.argv.slice(2));
  const script = readFauxScript(directory);
  await runDaemon({
    directory,
    signal: onShutdownSignal(),
    ready: (line) => console.log(line),
    closeClaudeCode: async () => {},
    providers: (settings) => ({
      ...createFauxProviders(directory),
      ...(settings.credentialKey?.source === 'file'
        ? { keySource: createKeyFileSource(settings.credentialKey.path) }
        : {}),
    }),
    ...(script.idleMs ? { idleMs: script.idleMs } : {}),
    ...(script.pollMs ? { pollMs: script.pollMs } : {}),
    // A test stands in for another app version's daemon with its own build.
    ...(process.env.MOONBASE_TEST_DAEMON_BUILD
      ? { build: process.env.MOONBASE_TEST_DAEMON_BUILD }
      : {}),
  });
} catch (error) {
  console.error(JSON.stringify({ event: 'failed', error: describeFailure(error) }));
  process.exitCode = 1;
}
