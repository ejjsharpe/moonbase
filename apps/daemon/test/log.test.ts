import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lstat, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { openDaemonLog, type LogRecord } from '../src/log.ts';
import { temporaryRoot } from './daemon-fixture.ts';

test('the daemon log rotates within its bound and keeps only its own fields', async () => {
  const root = await temporaryRoot();
  try {
    const directory = join(root, 'data');
    await mkdir(directory, { mode: 0o700 });
    const log = await openDaemonLog(directory, { maxBytes: 512, keep: 2 });
    for (let index = 0; index < 100; index++)
      log.write({
        event: 'ready',
        port: index,
        token: 'never-logged-token',
        body: 'never-logged-body',
      } as LogRecord);
    log.close();
    const folder = join(directory, 'logs');
    assert.deepEqual((await readdir(folder)).sort(), [
      'daemon.1.log',
      'daemon.2.log',
      'daemon.log',
    ]);
    for (const name of await readdir(folder)) {
      const info = await lstat(join(folder, name));
      assert.ok(info.size <= 512, name);
      assert.equal(info.mode & 0o777, 0o600, name);
      const text = await readFile(join(folder, name), 'utf8');
      assert.ok(!text.includes('never-logged'), name);
    }
    const last = (await readFile(join(folder, 'daemon.log'), 'utf8')).trim().split('\n').pop()!;
    assert.equal(JSON.parse(last).port, 99);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the daemon log refuses a symlinked log file', async () => {
  const root = await temporaryRoot();
  try {
    const directory = join(root, 'data');
    await mkdir(join(directory, 'logs'), { recursive: true, mode: 0o700 });
    await symlink(join(root, 'elsewhere'), join(directory, 'logs', 'daemon.log'));
    await assert.rejects(openDaemonLog(directory), { code: 'Persistence' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
