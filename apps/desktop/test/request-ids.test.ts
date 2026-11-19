import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Deferred, Effect, Fiber, FileSystem, Layer } from 'effect';
import * as PlatformError from 'effect/PlatformError';
import * as NodeServices from '@effect/platform-node/NodeServices';
import type { RequestStoreError } from '@moonbase/contracts/ipc-errors';
import { makeFileRequestIds } from '../src/main/request-ids.ts';

/** A request store's path in a new temporary profile, removed after the test. */
async function makeStorePath(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'moonbase-request-ids-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'chat-requests.json');
}
/** The node file system, opening files with `open` made from its own. */
const replaceOpen = (open: (fs: FileSystem.FileSystem) => FileSystem.FileSystem['open']) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs) => FileSystem.FileSystem.of({ ...fs, open: open(fs) })),
  ).pipe(Layer.provide(NodeServices.layer));
/** `file` with `override` in place of some of its operations. */
const overrideFile = (file: FileSystem.File, override: Partial<FileSystem.File>): FileSystem.File =>
  Object.create(
    file,
    Object.fromEntries(Object.entries(override).map(([name, value]) => [name, { value }])),
  ) as FileSystem.File;
const failedSync = PlatformError.systemError({
  _tag: 'Unknown',
  module: 'FileSystem',
  method: 'sync',
});
/** Opens the store in `file` again, as after a restart. */
const reopen = (file: string) => makeFileRequestIds(file).pipe(Effect.provide(NodeServices.layer));

test('a store that cannot be read or decoded fails each request instead of issuing a new ID', async (t) => {
  const failureOf = async (prepare: (file: string) => Promise<void>) => {
    const file = await makeStorePath(t);
    await prepare(file);
    const failure: RequestStoreError = await Effect.runPromise(
      Effect.flatMap(reopen(file), (ids) => Effect.flip(ids.issue('k'))),
    );
    return failure.failure;
  };
  assert.equal(await failureOf((file) => mkdir(file)), 'unreadable');
  // A value the workspace RPC would refuse as a request ID is as corrupt as a damaged file.
  for (const contents of ['{not json', '{"k":""}', '{"k":7}']) {
    let file = '';
    assert.equal(
      await failureOf(async (path) => {
        file = path;
        await writeFile(path, contents);
      }),
      'corrupt',
    );
    assert.equal(await readFile(file, 'utf8'), contents);
  }
});

test('an interrupted request finishes the write it started, and the store keeps each ID it returned', async (t) => {
  const file = await makeStorePath(t);
  const { closedMidWrite, issued, restarted } = await Effect.runPromise(
    Effect.gen(function* () {
      const writing = yield* Deferred.make<void>(),
        resume = yield* Deferred.make<void>();
      let writes = 0,
        pending = false,
        closedMidWrite = false;
      // The first write pauses as a slow native write would, and notes if its file is closed
      // before it ends.
      const files = replaceOpen(
        (fs) => (path, options) =>
          Effect.gen(function* () {
            const opened = yield* fs.open(path, options);
            if (path === dirname(file)) return opened;
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                if (pending) closedMidWrite = true;
              }),
            );
            return overrideFile(opened, {
              writeAll: (bytes) =>
                writes++ > 0
                  ? opened.writeAll(bytes)
                  : Effect.gen(function* () {
                      pending = true;
                      yield* Deferred.succeed(writing, undefined);
                      yield* Deferred.await(resume);
                      yield* opened.writeAll(bytes);
                      pending = false;
                    }),
            });
          }),
      );
      const ids = yield* makeFileRequestIds(file).pipe(Effect.provide(files));
      const first = yield* Effect.forkChild(ids.issue('first'));
      yield* Deferred.await(writing);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(first));
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(interrupting);
      const issued = { first: yield* ids.issue('first'), next: yield* ids.issue('next') };
      const restarted = yield* reopen(file);
      return {
        closedMidWrite,
        issued,
        restarted: { first: yield* restarted.issue('first'), next: yield* restarted.issue('next') },
      };
    }),
  );
  assert.equal(closedMidWrite, false);
  assert.deepEqual(restarted, issued);
});

test('after a write fails past its rename, no ID is returned until the folder is synced and the file read again', async (t) => {
  const file = await makeStorePath(t);
  const { kept, issued, restarted } = await Effect.runPromise(
    Effect.gen(function* () {
      let failSync = false;
      const files = replaceOpen(
        (fs) => (path, options) =>
          Effect.map(fs.open(path, options), (opened) =>
            path === dirname(file)
              ? overrideFile(opened, {
                  sync: Effect.suspend(() => (failSync ? Effect.fail(failedSync) : opened.sync)),
                })
              : opened,
          ),
      );
      const ids = yield* makeFileRequestIds(file).pipe(Effect.provide(files));
      const kept = yield* ids.issue('k');
      failSync = true;
      // The rename removed `k` from the file, but the folder never synced.
      const forgot = yield* Effect.flip(ids.forget('k', kept));
      const unsynced = yield* Effect.flip(ids.issue('k'));
      assert.deepEqual([forgot.failure, unsynced.failure], ['unwritable', 'unwritable']);
      failSync = false;
      const issued = yield* ids.issue('k');
      return { kept, issued, restarted: yield* (yield* reopen(file)).issue('k') };
    }),
  );
  assert.notEqual(issued, kept);
  assert.equal(restarted, issued);
});

test('forgetting an ID leaves one issued since for the same key', async (t) => {
  const file = await makeStorePath(t);
  const { later, kept } = await Effect.runPromise(
    Effect.gen(function* () {
      const ids = yield* reopen(file);
      const earlier = yield* ids.issue('k');
      yield* ids.forget('k', earlier);
      const later = yield* ids.issue('k');
      // A late answer to the earlier attempt.
      yield* ids.forget('k', earlier);
      return { later, kept: yield* (yield* reopen(file)).issue('k') };
    }),
  );
  assert.equal(kept, later);
});
