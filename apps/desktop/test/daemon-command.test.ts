import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDaemonCommand } from '../src/main/daemon-command.ts';
import {
  bounded,
  launchFrom,
  missingPackageProbe,
  plantHostileBunFiles,
  prepareDaemonRoot,
  runProbe,
  startDaemonCommand,
  withLocalRegistry,
  writeHostilePreload,
} from './fixtures/daemon-process.ts';

const dist = fileURLToPath(new URL('../dist', import.meta.url));
const source = fileURLToPath(new URL('../../daemon/src/main.ts', import.meta.url));
const development = {
  packaged: false,
  resourcesPath: '/unused',
  bundleDirectory: dist,
  build: 'unused',
};
const options = ['--no-env-file', '--config=/dev/null', '--no-install'];
const ws = { WS_NO_BUFFER_UTIL: '1', WS_NO_UTF_8_VALIDATE: '1' };

test('a packaged app runs its own Bun runtime on the bundled daemon, from its data directory', () => {
  const resources = '/Applications/Moonbase.app/Contents/Resources';
  assert.deepEqual(
    findDaemonCommand(
      {
        packaged: true,
        resourcesPath: resources,
        bundleDirectory: join(resources, 'app.asar'),
        build: 'bundle-digest',
      },
      '/private/data',
      {
        PATH: '/usr/bin:/bin',
        HOME: '/Users/someone',
        BUN_OPTIONS: '--preload /tmp/x.ts',
        BUN_CONFIG_REGISTRY: 'http://127.0.0.1:1/',
        BUN_INSTALL: '/tmp/bun',
        NODE_OPTIONS: '--require /tmp/x.js',
        NODE_PATH: '/tmp/node_modules',
        UNSET: undefined,
      },
    ),
    {
      command: '/Applications/Moonbase.app/Contents/Helpers/bun',
      args: [...options, join(resources, 'daemon/daemon.mjs'), '/private/data'],
      cwd: '/private/data',
      env: { PATH: '/usr/bin:/bin', HOME: '/Users/someone', ...ws },
      build: 'bundle-digest',
    },
  );
});

test('the daemon command loads no .env or bunfig.toml from its working folder', async () => {
  const { root, directory } = await prepareDaemonRoot();
  try {
    await plantHostileBunFiles(directory, join(root, 'preloaded'));
    const daemon = findDaemonCommand(development, directory, {
      PATH: process.env.PATH ?? '',
      HOME: root,
    });
    const probe = join(root, 'probe.mjs');
    await writeFile(probe, 'console.log(JSON.stringify(process.env.MOONBASE_HOSTILE ?? null))');
    const run = await launchFrom(directory, () => runProbe(daemon, probe));
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), 'null');
    await assert.rejects(access(join(root, 'preloaded')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the daemon command drops BUN_OPTIONS and NODE_OPTIONS from the caller environment', async () => {
  const { root, directory } = await prepareDaemonRoot();
  try {
    const marker = join(root, 'preloaded');
    const hostile = await writeHostilePreload(root, marker);
    const daemon = findDaemonCommand(development, directory, {
      PATH: process.env.PATH ?? '',
      HOME: root,
      BUN_OPTIONS: hostile,
      NODE_OPTIONS: `--require ${join(root, 'options-preload.ts')}`,
    });
    const probe = join(root, 'probe.mjs');
    await writeFile(
      probe,
      'console.log(JSON.stringify([process.env.BUN_OPTIONS ?? null, process.env.NODE_OPTIONS ?? null]))',
    );
    // Kept, it would run the preload.
    const control = await runProbe(daemon, probe, { ...daemon.env, BUN_OPTIONS: hostile });
    assert.equal(control.status, 0, control.stderr);
    await access(marker);
    await rm(marker);
    const run = await runProbe(daemon, probe);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), '[null,null]');
    await assert.rejects(access(marker), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the daemon command never asks a registry for a package it cannot resolve', async () => {
  const { root, directory } = await prepareDaemonRoot();
  try {
    const daemon = findDaemonCommand(development, directory, {
      PATH: process.env.PATH ?? '',
      HOME: root,
    });
    // The probe sits in a temporary folder with no `node_modules` above it, as the bundle does.
    const probe = join(root, 'probe.mjs');
    await writeFile(probe, missingPackageProbe);
    // Only a local listener: with auto-install on, Bun asks this, never npm.
    const probeWith = (command: typeof daemon) =>
      withLocalRegistry((registry) =>
        runProbe(command, probe, {
          ...daemon.env,
          BUN_CONFIG_REGISTRY: registry,
          BUN_INSTALL_CACHE_DIR: join(root, 'cache'),
        }),
      );
    const control = await probeWith({
      ...daemon,
      args: daemon.args.filter((arg) => arg !== '--no-install'),
    });
    assert.notEqual(control.requests.length, 0, 'without --no-install, Bun asks the registry');
    const { result: run, requests } = await probeWith(daemon);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), 'missing');
    assert.deepEqual(requests, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('development runs the daemon from source with the bun on PATH, with no packaging step', async () => {
  const daemon = findDaemonCommand(development, '/private/data', {
    PATH: '/usr/bin',
  });
  assert.equal(daemon.command, 'bun');
  assert.deepEqual(daemon.args, [...options, source, '/private/data']);
  assert.equal(daemon.cwd, '/private/data');
  assert.deepEqual(daemon.env, { PATH: '/usr/bin', ...ws });
  assert.equal(daemon.build, 'development');
  await access(source);

  const { root, directory } = await prepareDaemonRoot();
  // Bun would load these from the folder the app was launched from, and from the daemon's own.
  const launch = join(root, 'launch');
  await mkdir(launch);
  await plantHostileBunFiles(launch, join(root, 'preloaded'));
  await plantHostileBunFiles(directory, join(root, 'preloaded'));
  const started = launchFrom(launch, () =>
    startDaemonCommand(
      findDaemonCommand(development, directory, {
        PATH: process.env.PATH ?? '',
        HOME: root,
        PI_CLAUDE_CODE_COMMAND: '/nonexistent/claude',
      }),
    ),
  );
  try {
    const ready = await bounded(started.ready);
    const endpoint = JSON.parse(await readFile(join(directory, 'endpoint.json'), 'utf8'));
    assert.equal(endpoint.port, ready.port);
    assert.equal(endpoint.build, 'development', 'the source entry is the development build');
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
