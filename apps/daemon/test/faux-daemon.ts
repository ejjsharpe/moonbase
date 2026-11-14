import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKeyFileSource } from '@moonbase/chat-runtime/credentials';
import { runDaemon } from '../src/daemon.ts';
import { readDirectoryArgument } from '../src/data-directory.ts';
import { describeFailure } from '../src/failure.ts';
import { onShutdownSignal } from '../src/signals.ts';
import { findFilesystemHelper } from '../src/workspace.ts';
import { createFauxProviders, readFauxScript } from './faux-provider.ts';

/**
 * With `MOONBASE_TEST_HOLD_READ` naming a folder, the first helper `read` of a file ending in
 * `a.ts` that starts after the test created `<folder>/arm` stops itself (SIGSTOP) and writes its
 * process ID to `<folder>/held`, so a test can cancel a read that is in flight. Anything else runs
 * the real helper.
 */
function holdingHelper(folder: string, helper: string) {
  const script = join(folder, 'helper');
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      `if [ "$1" = read ]; then case "$2" in *a.ts) if mv '${folder}/arm' '${folder}/armed' 2>/dev/null; then echo $$ > '${folder}/held'; kill -STOP $$; fi;; esac; fi`,
      `exec '${helper}' "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(script, 0o755);
  return script;
}

/**
 * The daemon's test entry: `bun test/faux-daemon.ts <absolute data directory>`. It composes the
 * real daemon with faux providers, scripted by `faux.json`, and an in-memory credential key, or the
 * temporary key file `daemon.json` names, so sign-ins survive a restart.
 */
const holdingRead = (helper: string | undefined) =>
  helper && process.env.MOONBASE_TEST_HOLD_READ
    ? holdingHelper(process.env.MOONBASE_TEST_HOLD_READ, helper)
    : helper;
try {
  const directory = readDirectoryArgument(process.argv.slice(2));
  const script = readFauxScript(directory);
  await runDaemon({
    directory,
    signal: onShutdownSignal(),
    ready: (line) => console.log(line),
    closeClaudeCode: async () => {},
    filesystemHelper: holdingRead(findFilesystemHelper(import.meta.url, { fromSource: true })),
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
