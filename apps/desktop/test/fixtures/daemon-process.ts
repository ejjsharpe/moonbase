import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonCommand } from '../../src/main/daemon/daemon-command.ts';

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

/** Starts a daemon command exactly as given and resolves `ready` with its ready line. */
export function startDaemonCommand(daemon: DaemonCommand) {
  const child = spawn(daemon.command, daemon.args, {
    cwd: daemon.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: daemon.env,
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

/**
 * A `BUN_OPTIONS` that would preload a script writing `marker`, as a hostile environment could
 * set. A daemon command must drop it.
 */
export async function writeHostilePreload(folder: string, marker: string) {
  const preload = join(folder, 'options-preload.ts');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`;
  await writeFile(preload, script, { mode: 0o600 });
  return `--preload ${preload}`;
}

/**
 * Runs `run` with a local npm registry that records every request and answers 404, so Bun's
 * auto-install, if it happened, would reach only this listener and never the real registry.
 */
export async function withLocalRegistry<T>(
  run: (registry: string) => Promise<T> | T,
): Promise<{ result: T; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(404, { 'content-type': 'application/json' }).end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as { port: number };
    return { result: await run(`http://127.0.0.1:${port}/`), requests };
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

/** A probe that imports a package no folder above it installs, as the bundled `ws` may. */
export const missingPackageProbe =
  "try { await import('moonbase-missing-package'); console.log('loaded'); } catch { console.log('missing'); }";

/**
 * Runs a daemon command's runtime and options on `probe` in place of the daemon's entry, without
 * blocking this process (which may be serving the probe's registry).
 */
export async function runProbe(
  daemon: DaemonCommand,
  probe: string,
  env: Record<string, string> = daemon.env,
) {
  const entry = daemon.args.at(-2);
  const child = spawn(
    daemon.command,
    daemon.args.map((arg) => (arg === entry ? probe : arg)),
    { cwd: daemon.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (bytes) => (stdout += bytes));
  child.stderr.on('data', (bytes) => (stderr += bytes));
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  try {
    const [status] = await bounded(exited);
    return { status, stdout, stderr };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
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
