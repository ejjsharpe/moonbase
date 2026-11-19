import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer, Scope } from 'effect';
import * as PlatformError from 'effect/PlatformError';
import * as NodeServices from '@effect/platform-node/NodeServices';
import type { RequestStoreError } from '@moonbase/contracts/ipc-errors';
import { makeFileRequestIds } from '../src/main/request-ids.ts';

/** A request store's path in a new temporary profile, removed after the test. */
async function makeStorePath(t: TestContext, folder = '.') {
  const directory = await mkdtemp(join(tmpdir(), 'moonbase-request-ids-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, folder, 'chat-requests.json');
}
/** The node file system with `override` in place of some of its operations. */
const replaceFiles = (override: (fs: FileSystem.FileSystem) => Partial<FileSystem.FileSystem>) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs) => FileSystem.FileSystem.of({ ...fs, ...override(fs) })),
  ).pipe(Layer.provide(NodeServices.layer));
/** `file` with `override` in place of some of its operations. */
const overrideFile = (file: FileSystem.File, override: Partial<FileSystem.File>): FileSystem.File =>
  Object.create(
    file,
    Object.fromEntries(Object.entries(override).map(([name, value]) => [name, { value }])),
  ) as FileSystem.File;
const fault = (method: string) =>
  PlatformError.systemError({ _tag: 'Unknown', module: 'FileSystem', method });
/** Opens the store in `file` again, as after a restart, for the rest of the test's effect. */
const reopen = (file: string) => makeFileRequestIds(file).pipe(Effect.provide(NodeServices.layer));

test('a store that cannot be read or decoded fails each request instead of issuing a new ID', async (t) => {
  const failureOf = async (prepare: (file: string) => Promise<void>) => {
    const file = await makeStorePath(t);
    await prepare(file);
    const failure: RequestStoreError = await Effect.runPromise(
      Effect.scoped(Effect.flatMap(reopen(file), (ids) => Effect.flip(ids.issue('k')))),
    );
    return failure.failure;
  };
  assert.equal(await failureOf((file) => mkdir(file)), 'unreadable');
  // A value the workspace RPC would refuse as a request ID is as corrupt as a damaged file, and
  // so is a key with a damaged byte, which would otherwise read as another key.
  const id = '0b7d6c1e-8a4f-4f43-9a2e-4c2f0b9d1e11';
  const damagedKey = Buffer.from(`{"k":"${id}"}`);
  damagedKey[2] = 0xff;
  for (const contents of ['{not json', '{"k":""}', '{"k":7}', damagedKey]) {
    let file = '';
    assert.equal(
      await failureOf(async (path) => {
        file = path;
        await writeFile(path, contents);
      }),
      'corrupt',
    );
    assert.deepEqual(await readFile(file), Buffer.from(contents));
  }
});

test('a write runs to its end without its caller, and closing the store waits for it', async (t) => {
  const file = await makeStorePath(t);
  const { caller, stored, renames, reopened } = await Effect.runPromise(
    Effect.gen(function* () {
      const renaming = yield* Deferred.make<void>(),
        resume = yield* Deferred.make<void>();
      let renames = 0;
      // The first rename pauses as a slow native one would, after the temporary file is closed.
      const files = replaceFiles((fs) => ({
        rename: (from, to) =>
          renames++ > 0
            ? fs.rename(from, to)
            : Effect.andThen(
                Deferred.succeed(renaming, undefined),
                Effect.andThen(Deferred.await(resume), fs.rename(from, to)),
              ),
      }));
      const scope = yield* Scope.make();
      const ids = yield* makeFileRequestIds(file).pipe(Scope.provide(scope), Effect.provide(files));
      const first = yield* Effect.forkChild(ids.issue('first'));
      yield* Deferred.await(renaming);
      // The caller goes at once; the store, as it closes, waits for the write it started.
      yield* Fiber.interrupt(first);
      const caller = yield* Fiber.await(first);
      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void), {
        startImmediately: true,
      });
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(closing);
      const stored = JSON.parse(yield* Effect.promise(() => readFile(file, 'utf8')));
      const before = renames;
      const reopened = yield* Effect.scoped(
        Effect.flatMap(makeFileRequestIds(file).pipe(Effect.provide(files)), (again) =>
          again.issue('first'),
        ),
      );
      return { caller, stored, renames: renames - before, reopened };
    }),
  );
  assert(Exit.hasInterrupts(caller));
  // The ID the store wrote is the one it returns after a restart, without writing another.
  assert.equal(reopened, stored.first);
  assert.equal(renames, 0);
});

test('a write that fails before its rename is simply retried; one that fails after it, by a failure or a defect, stops the store until the folder syncs and the file is read again', async (t) => {
  const file = await makeStorePath(t, 'profile');
  const { kept, issued, restarted } = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        let failFolder = true,
          breakFolder = false;
        const files = replaceFiles((fs) => ({
          makeDirectory: (path, options) =>
            Effect.suspend(() => {
              if (!failFolder) return fs.makeDirectory(path, options);
              failFolder = false;
              return Effect.fail(fault('makeDirectory'));
            }),
          open: (path, options) =>
            Effect.map(fs.open(path, options), (opened) =>
              path === dirname(file)
                ? overrideFile(opened, {
                    sync: Effect.suspend(() => (breakFolder ? Effect.die('sync') : opened.sync)),
                  })
                : opened,
            ),
        }));
        const ids = yield* makeFileRequestIds(file).pipe(Effect.provide(files));
        // A fresh profile whose folder could not be made yet.
        assert.equal((yield* Effect.flip(ids.issue('k'))).failure, 'unwritable');
        const kept = yield* ids.issue('k');
        breakFolder = true;
        // The rename removed `k` from the file, but the folder never synced.
        yield* ids.forget('k', kept);
        assert(Exit.isFailure(yield* Effect.exit(ids.issue('k'))));
        breakFolder = false;
        const issued = yield* ids.issue('k');
        const restarted = yield* Effect.scoped(Effect.flatMap(reopen(file), (r) => r.issue('k')));
        return { kept, issued, restarted };
      }),
    ),
  );
  assert.notEqual(issued, kept);
  assert.equal(restarted, issued);
});

test('forgetting an ID leaves one issued since for the same key', async (t) => {
  const file = await makeStorePath(t);
  const { later, kept } = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const ids = yield* reopen(file);
        const earlier = yield* ids.issue('k');
        yield* ids.forget('k', earlier);
        const later = yield* ids.issue('k');
        // A late answer to the earlier attempt.
        yield* ids.forget('k', earlier);
        const kept = yield* Effect.scoped(Effect.flatMap(reopen(file), (r) => r.issue('k')));
        return { later, kept };
      }),
    ),
  );
  assert.equal(kept, later);
});
