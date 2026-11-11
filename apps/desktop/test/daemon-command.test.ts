import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDaemonCommand } from '../src/main/daemon-command.ts';
import {
  bounded,
  launchFrom,
  plantHostileBunFiles,
  prepareDaemonRoot,
  startDaemonCommand,
} from './daemon-process.ts';

const dist = fileURLToPath(new URL('../dist', import.meta.url));
const source = fileURLToPath(new URL('../../daemon/src/main.ts', import.meta.url));

test('a packaged app runs its own Bun runtime on the bundled daemon, from its data directory', () => {
  const resources = '/Applications/Moonbase.app/Contents/Resources';
  assert.deepEqual(
    findDaemonCommand(
      {
        packaged: true,
        resourcesPath: resources,
        bundleDirectory: join(resources, 'app.asar'),
      },
      '/private/data',
    ),
    {
      command: '/Applications/Moonbase.app/Contents/Helpers/bun',
      args: [
        '--no-env-file',
        '--config=/dev/null',
        join(resources, 'daemon/daemon.mjs'),
        '/private/data',
      ],
      cwd: '/private/data',
    },
  );
});

test('the daemon command loads no .env or bunfig.toml from its working folder', async () => {
  const { root, directory } = await prepareDaemonRoot();
  try {
    await plantHostileBunFiles(directory, join(root, 'preloaded'));
    const daemon = findDaemonCommand(
      { packaged: false, resourcesPath: '/unused', bundleDirectory: dist },
      directory,
    );
    // The same runtime options on a probe in place of the daemon's entry.
    const probe = join(root, 'probe.mjs');
    await writeFile(probe, 'console.log(JSON.stringify(process.env.MOONBASE_HOSTILE ?? null))');
    const run = launchFrom(directory, () =>
      spawnSync(
        daemon.command,
        daemon.args.map((arg) => (arg === source ? probe : arg)),
        {
          cwd: daemon.cwd,
          env: { PATH: process.env.PATH ?? '', HOME: root },
          encoding: 'utf8',
        },
      ),
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), 'null');
    await assert.rejects(access(join(root, 'preloaded')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('development runs the daemon from source with the bun on PATH, with no packaging step', async () => {
  const daemon = findDaemonCommand(
    { packaged: false, resourcesPath: '/unused', bundleDirectory: dist },
    '/private/data',
  );
  assert.equal(daemon.command, 'bun');
  assert.deepEqual(daemon.args, ['--no-env-file', '--config=/dev/null', source, '/private/data']);
  assert.equal(daemon.cwd, '/private/data');
  await access(source);

  const { root, directory } = await prepareDaemonRoot();
  // Bun would load these from the folder the app was launched from, and from the daemon's own.
  const launch = join(root, 'launch');
  await mkdir(launch);
  await plantHostileBunFiles(launch, join(root, 'preloaded'));
  await plantHostileBunFiles(directory, join(root, 'preloaded'));
  const started = launchFrom(launch, () =>
    startDaemonCommand(
      findDaemonCommand(
        { packaged: false, resourcesPath: '/unused', bundleDirectory: dist },
        directory,
      ),
      {
        PATH: process.env.PATH ?? '',
        HOME: root,
        PI_CLAUDE_CODE_COMMAND: '/nonexistent/claude',
      },
    ),
  );
  try {
    const ready = await bounded(started.ready);
    const endpoint = JSON.parse(await readFile(join(directory, 'endpoint.json'), 'utf8'));
    assert.equal(endpoint.port, ready.port);
    assert.deepEqual(await started.stop(), [0, null]);
    await assert.rejects(access(join(directory, 'endpoint.json')), {
      code: 'ENOENT',
    });
    await assert.rejects(access(join(root, 'preloaded')), { code: 'ENOENT' });
  } finally {
    await started.stop('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
