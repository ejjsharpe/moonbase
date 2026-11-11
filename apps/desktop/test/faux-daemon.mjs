// Test-only: the daemon's faux entry (faux providers, an in-memory credential key, provider
// network refused), as a command main spawns exactly. It never reaches shipped builds.
import { spawnSync } from 'node:child_process';
import { constants, mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const daemonTests = fileURLToPath(new URL('../../daemon/test/', import.meta.url));
// The ripgrep `scripts/prepare-ripgrep.mjs` prepares, which the app bundles; a test's PATH has none.
const ripgrep = fileURLToPath(new URL('../../../dist/tools/ripgrep', import.meta.url));

/** The Bun that runs test daemons: `MOONBASE_TEST_BUN`, else the `bun` on this process's PATH. */
export function findTestBun() {
  if (process.env.MOONBASE_TEST_BUN) return process.env.MOONBASE_TEST_BUN;
  const found = spawnSync('/bin/sh', ['-c', 'command -v bun'], { encoding: 'utf8' });
  if (found.status !== 0 || !found.stdout.trim()) throw Error('Put Bun 1.4.4 on PATH.');
  return found.stdout.trim();
}

/**
 * Starts the faux daemon on `directory` with Bun's options as the app passes them. It reports
 * `build`, as another app version's daemon would report its own.
 */
export function makeFauxDaemonCommand(directory, bun = findTestBun(), build = 'development') {
  return {
    command: bun,
    args: [
      '--no-env-file',
      '--config=/dev/null',
      '--no-install',
      '--preload',
      join(daemonTests, 'no-network.ts'),
      join(daemonTests, 'faux-daemon.ts'),
      directory,
    ],
    cwd: directory,
    env: {
      PATH: `${ripgrep}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: process.env.HOME ?? '',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      WS_NO_BUFFER_UTIL: '1',
      WS_NO_UTF_8_VALIDATE: '1',
      ...(build === 'development' ? {} : { MOONBASE_TEST_DAEMON_BUILD: build }),
    },
    build,
  };
}

/**
 * Prepares a profile's daemon directory before the app starts it: private, with a faux script
 * (by default, exit 5 seconds after the last client) and a key-file credential key, so even the
 * real daemon entry never reaches the Keychain.
 */
export async function prepareDaemonData(userData, script = { idleMs: 5000, pollMs: 500 }) {
  const directory = join(userData, 'daemon-v1');
  await mkdir(userData, { recursive: true, mode: 0o700 });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'faux.json'), JSON.stringify(script), { mode: 0o600 });
  await writeFile(
    join(directory, 'daemon.json'),
    JSON.stringify({
      mode: 'local',
      credentialKey: { source: 'file', path: join(userData, 'daemon-key') },
    }),
    { mode: 0o600, flag: 'w' },
  );
  return directory;
}

/** Replaces the faux script of a running daemon; later model calls read it. */
export async function writeFauxScript(directory, script) {
  await writeFile(join(directory, 'faux.json'), JSON.stringify(script), { mode: 0o600 });
}

/** The ID of the daemon process `endpoint.json` names, if any. */
export async function readDaemonPid(directory) {
  let file;
  try {
    file = await open(join(directory, 'endpoint.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(await file.readFile('utf8')).pid;
  } catch {
    return undefined;
  } finally {
    await file.close();
  }
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Stops the daemon `endpoint.json` names and waits for it, escalating to SIGKILL. */
export async function stopDaemon(directory, pid) {
  pid ??= await readDaemonPid(directory);
  if (!pid || !isAlive(pid)) return;
  process.kill(pid, 'SIGTERM');
  for (let waited = 0; isAlive(pid); waited += 25) {
    if (waited === 15000) process.kill(pid, 'SIGKILL');
    if (waited > 20000) throw Error('The test daemon did not stop.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The model calls the faux daemon recorded, one per call. */
export async function readFauxCalls(directory) {
  try {
    return (await readFile(join(directory, 'faux-calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
      .length;
  } catch {
    return 0;
  }
}

/**
 * Makes main start the faux daemon rather than the real one, from a test-only entry that runs
 * before main. Unless the test wrote its own `faux.json`, the daemon exits 5 seconds after its
 * last client, so none outlives its test for long; main restarts it on demand.
 */
export function installFauxDaemon() {
  const bun = findTestBun();
  globalThis.moonbaseTestDaemonCommand = (directory) => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(join(directory, 'faux.json'), JSON.stringify({ idleMs: 5000, pollMs: 500 }), {
        mode: 0o600,
        flag: 'wx',
      });
    } catch {
      // The test's own script.
    }
    return makeFauxDaemonCommand(directory, bun);
  };
}

/**
 * Stops every test daemon still running on a temporary data directory: the faux entry of this
 * checkout, or a packaged app's daemon. A daemon outlives the app that started it.
 */
export async function stopTestDaemons() {
  const temporary = await realpath(tmpdir());
  const listed = spawnSync('/bin/ps', ['-axo', 'pid=,args='], { encoding: 'utf8' }).stdout ?? '';
  const pids = [];
  for (const line of listed.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pid, args] = match;
    const directory = args.split(' ').at(-1) ?? '';
    if (
      (args.includes(join(daemonTests, 'faux-daemon.ts')) ||
        args.includes('Moonbase.app/Contents/Resources/daemon/daemon.mjs')) &&
      (directory.startsWith(temporary + '/') || directory.startsWith('/private' + temporary + '/'))
    )
      pids.push(Number(pid));
  }
  await Promise.all(pids.map((pid) => stopDaemon('', pid)));
  return pids.length;
}
