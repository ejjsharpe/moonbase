import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonCommand } from '../src/main/daemon-command.ts';

export async function bounded<T>(promise: Promise<T>, ms = 20000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('Did not settle in time.')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A new private root with a local-mode data directory `data` inside it, whose credential key is
 * a file in the root, so a daemon started on it never reaches the Keychain.
 */
export async function prepareDaemonRoot() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-desktop-daemon-')));
  const directory = join(root, 'data');
  await mkdir(directory, { mode: 0o700 });
  await writeFile(
    join(directory, 'daemon.json'),
    JSON.stringify({
      mode: 'local',
      credentialKey: { source: 'file', path: join(root, 'key') },
    }),
    { mode: 0o600 },
  );
  return { root, directory };
}

/** Starts a daemon command and resolves `ready` with its ready line. */
export function startDaemonCommand(daemon: DaemonCommand, env: Record<string, string>) {
  const child = spawn(daemon.command, daemon.args, {
    cwd: daemon.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  let output = '',
    errors = '';
  child.stdout.on('data', (bytes) => (output += bytes));
  child.stderr.on('data', (bytes) => (errors += bytes));
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  const ready = new Promise<{
    port: number;
    host: { hostId: string; storeId: string };
  }>((resolve, reject) => {
    const data = () => {
      const line = output.split('\n').find((text) => text.includes('"event":"ready"'));
      if (!line) return;
      child.stdout.off('data', data);
      resolve(JSON.parse(line));
    };
    child.stdout.on('data', data);
    child.once('error', reject);
    void exited.then(() => reject(Error('Daemon exited before ready: ' + errors)));
  });
  ready.catch(() => {});
  return {
    child,
    exited,
    ready,
    get output() {
      return output;
    },
    get errors() {
      return errors;
    },
    async stop(signal: NodeJS.Signals = 'SIGTERM') {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      try {
        return await bounded(exited);
      } catch {
        child.kill('SIGKILL');
        return await bounded(exited);
      }
    },
  };
}

/**
 * Plants what Bun would load from its working folder: a `.env` setting `MOONBASE_HOSTILE` and a
 * `bunfig.toml` whose preload writes `marker`. A daemon command must ignore both.
 */
export async function plantHostileBunFiles(folder: string, marker: string) {
  await writeFile(join(folder, '.env'), 'MOONBASE_HOSTILE=loaded\n', {
    mode: 0o600,
  });
  await writeFile(
    join(folder, 'hostile-preload.ts'),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`,
    { mode: 0o600 },
  );
  await writeFile(join(folder, 'bunfig.toml'), 'preload = ["./hostile-preload.ts"]\n', {
    mode: 0o600,
  });
}

/** Runs `start` with the process working folder set to `folder`, as a launch from there would. */
export function launchFrom<T>(folder: string, start: () => T): T {
  const previous = process.cwd();
  process.chdir(folder);
  try {
    return start();
  } finally {
    process.chdir(previous);
  }
}
