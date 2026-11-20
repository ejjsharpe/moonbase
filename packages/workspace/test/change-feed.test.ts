import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Fiber, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { makeChangeFeed } from '../src/host/change-feed.ts';

test('changes that overflow an unpulled feed make its next batch unnamed', async () => {
  const batch = await Effect.runPromise(
    Effect.gen(function* () {
      const feed = yield* makeChangeFeed(2);
      // Nothing pulls the feed yet, so the third change is dropped.
      for (const path of ['/a', '/b', '/c']) feed.offer({ path });
      const next = yield* Effect.forkChild(Stream.runHead(feed.batches));
      yield* TestClock.adjust('100 millis');
      return yield* Fiber.join(next);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  assert.equal(batch._tag, 'Some');
  assert.equal(batch.value.paths, undefined, 'a dropped path must not let the batch be filtered');
});
