import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lstat, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Cause, Effect, Exit } from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
import { DaemonJournal, journal, type JournalRecord } from '../src/journal.ts';
import { temporaryRoot } from './daemon-fixture.ts';

const runJournal = <A, E>(directory: string, effect: Effect.Effect<A, E>, limits = {}) =>
  Effect.runPromiseExit(
    effect.pipe(
      Effect.provide(DaemonJournal(directory, limits)),
      Effect.provide(BunServices.layer),
    ),
  );

test('the daemon journal rotates within its bound and keeps only its own fields', async () => {
  const root = await temporaryRoot();
  try {
    const directory = join(root, 'data');
    await mkdir(directory, { mode: 0o700 });
    const exit = await runJournal(
      directory,
      Effect.gen(function* () {
        for (let index = 0; index < 100; index++)
          yield* journal({
            event: 'ready',
            port: index,
            token: 'never-logged-token',
            body: 'never-logged-body',
          } as JournalRecord);
        // Nothing but a journal record reaches the file.
        yield* Effect.log('never-logged-message', { token: 'never-logged-token' });
      }),
      { maxBytes: 512, keep: 2 },
    );
    assert.ok(Exit.isSuccess(exit));
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
    assert.deepEqual(Object.keys(JSON.parse(last)), ['time', 'event', 'port']);
    assert.equal(JSON.parse(last).port, 99);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the daemon journal refuses a symlinked log file, and creates nothing where it leads', async () => {
  const root = await temporaryRoot();
  try {
    const directory = join(root, 'data');
    await mkdir(join(directory, 'logs'), { recursive: true, mode: 0o700 });
    await symlink(join(root, 'elsewhere'), join(directory, 'logs', 'daemon.log'));
    const exit = await runJournal(directory, Effect.void);
    assert.ok(Exit.isFailure(exit));
    assert.deepEqual(
      { ...(Cause.squash(exit.cause) as object) },
      { _tag: 'DataDirectoryError', problem: 'unsafe' },
    );
    await assert.rejects(lstat(join(root, 'elsewhere')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
