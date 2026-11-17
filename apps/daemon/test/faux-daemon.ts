import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeKeyFileSource } from '@moonbase/chat-runtime/credentials';
import { Console, Effect } from 'effect';
import { runDaemon } from '../src/daemon.ts';
import { argumentsConfig } from '../src/daemon-config.ts';
import { runDaemonProcess } from '../src/daemon-process.ts';
import { findFilesystemHelper } from '../src/executables.ts';
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
const args = process.argv.slice(2);
// The faux script is read before the daemon checks its directory; one it can't read is empty.
const script = args.length === 1 && args[0] ? readFauxScript(args[0]) : {};
const helper = holdingRead(findFilesystemHelper(import.meta.url, { fromSource: true }));
const daemon = runDaemon({
  ready: (line) => Console.log(line),
  closeClaudeCode: Effect.void,
  ...(helper ? { filesystemHelper: helper } : {}),
  providers: (settings) => ({
    ...createFauxProviders(args[0]!),
    ...(settings.credentialKey?.source === 'file'
      ? { keySource: makeKeyFileSource(settings.credentialKey.path) }
      : {}),
  }),
  // A test stands in for another app version's daemon with its own build.
  ...(process.env.MOONBASE_TEST_DAEMON_BUILD
    ? { build: process.env.MOONBASE_TEST_DAEMON_BUILD }
    : {}),
});
runDaemonProcess(
  daemon,
  argumentsConfig(args, {
    ...(script.idleMs ? { idle: `${script.idleMs} millis` } : {}),
    ...(script.pollMs ? { poll: `${script.pollMs} millis` } : {}),
  }),
);
