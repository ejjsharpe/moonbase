import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDaemonCommand } from '../src/main/daemon-command.ts';
import { bounded, prepareDaemonRoot, startDaemonCommand } from './daemon-process.ts';

const dist = fileURLToPath(new URL('../dist', import.meta.url));

test('a packaged app runs its own Bun runtime on the bundled daemon', () => {
  const resources = '/Applications/Moonbase.app/Contents/Resources';
  assert.deepEqual(
    findDaemonCommand(
      { packaged: true, resourcesPath: resources, bundleDirectory: join(resources, 'app.asar') },
      '/private/data',
    ),
    {
      command: '/Applications/Moonbase.app/Contents/Helpers/bun',
      args: [join(resources, 'daemon/daemon.mjs'), '/private/data'],
    },
  );
});

test('development runs the daemon from source with the bun on PATH, with no packaging step', async () => {
  const daemon = findDaemonCommand(
    { packaged: false, resourcesPath: '/unused', bundleDirectory: dist },
    '/private/data',
  );
  assert.equal(daemon.command, 'bun');
  assert.equal(daemon.args[0], fileURLToPath(new URL('../../daemon/src/main.ts', import.meta.url)));
  await access(daemon.args[0]!);

  const { root, directory } = await prepareDaemonRoot();
  const started = startDaemonCommand(
    findDaemonCommand(
      { packaged: false, resourcesPath: '/unused', bundleDirectory: dist },
      directory,
    ),
    {
      PATH: process.env.PATH ?? '',
      HOME: root,
      PI_CLAUDE_CODE_COMMAND: '/nonexistent/claude',
    },
  );
  try {
    const ready = await bounded(started.ready);
    const endpoint = JSON.parse(await readFile(join(directory, 'endpoint.json'), 'utf8'));
    assert.equal(endpoint.port, ready.port);
    assert.deepEqual(await started.stop(), [0, null]);
    await assert.rejects(access(join(directory, 'endpoint.json')), { code: 'ENOENT' });
  } finally {
    await started.stop('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
