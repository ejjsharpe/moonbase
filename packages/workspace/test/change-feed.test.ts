import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Fiber, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { makeChangeFeed, type Change } from '../src/host/change-feed.ts';

/** The first batch of a capacity-2 feed offered `changes` while nothing pulled it. */
const firstBatch = (changes: Change[]) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const feed = yield* makeChangeFeed(2);
      for (const change of changes) feed.offer(change);
      const next = yield* Effect.forkChild(Stream.runHead(feed.batches));
      yield* TestClock.adjust('100 millis');
      return yield* Fiber.join(next);
    }).pipe(Effect.provide(TestClock.layer())),
  );

test('changes that overflow an unpulled feed make its next batch unnamed', async () => {
  // The third change is dropped.
  const batch = await firstBatch([{ path: '/a' }, { path: '/b' }, { path: '/c' }]);
  assert.equal(batch._tag, 'Some');
  assert.equal(batch.value.paths, undefined, 'a dropped path must not let the batch be filtered');
});

test('a failure that overflows an unpulled feed still reaches its next batch', async () => {
  const batch = await firstBatch([{ path: '/a' }, { path: '/b' }, { error: 'watcher stopped' }]);
  assert.equal(batch._tag, 'Some');
  assert.equal(batch.value.error, 'watcher stopped');
});
