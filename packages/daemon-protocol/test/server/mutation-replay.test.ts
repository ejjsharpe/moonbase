import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Deferred, Effect, Fiber, Result, type Scope } from 'effect';
import { makeMutationReplay } from '../../src/server/mutation-replay.ts';

/**
 * A replay over faux approvals that record their runs; one of `/held` waits for `release`. Its
 * refusals and failures are covered over the wire in `transport.test.ts`.
 */
const replayFixture = Effect.gen(function* () {
  const replay = yield* makeMutationReplay;
  const runs: string[] = [];
  const release = yield* Deferred.make<void>();
  const approve = (requestId: string, path: string, operation = 'approveFolder') =>
    Effect.result(
      replay(
        operation,
        { requestId, path } as { requestId: string },
        Effect.gen(function* () {
          runs.push(`${requestId}:${path}`);
          if (path === '/held') yield* Deferred.await(release);
          return { requestId, path, run: runs.length };
        }),
      ),
    );
  // Starts a request and runs it until it waits, so what it started is in place.
  const start = (requestId: string, path: string) =>
    Effect.forkChild(approve(requestId, path), { startImmediately: true });
  const logout = (ownerId: string) =>
    replay(
      'logoutProvider',
      { ownerId, requestId: 'shared' },
      Effect.sync(() => ({ ownerId, run: runs.push(`logout:${ownerId}`) })),
    );
  return { runs, release, approve, start, logout };
});
const failureTag = (result: Result.Result<unknown, unknown>) =>
  Result.isFailure(result) ? (result.failure as { _tag: string })._tag : 'succeeded';
const runScoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect));

test('a repeated mutation joins or replays the first outcome without running again, and a reused request ID is refused', () =>
  runScoped(
    Effect.gen(function* () {
      const { runs, release, approve, start, logout } = yield* replayFixture;
      // Repeats while the first runs join it, and once it settles replay it.
      const first = yield* start('one', '/held');
      const joined = yield* start('one', '/held');
      assert.deepEqual(runs, ['one:/held']);
      yield* Deferred.succeed(release, undefined);
      const outcome = yield* Fiber.join(first);
      assert.equal(failureTag(outcome), 'succeeded');
      assert.deepEqual(yield* Fiber.join(joined), outcome);
      assert.deepEqual(yield* approve('one', '/held'), outcome);
      // The ID binds its whole input and its operation.
      assert.equal(failureTag(yield* approve('one', '/other')), 'RequestReusedError');
      assert.equal(
        failureTag(yield* approve('one', '/held', 'markFolderAsProject')),
        'RequestReusedError',
      );
      // One owner's request IDs never answer for another's.
      const a = yield* logout('a');
      assert.notDeepEqual(yield* logout('b'), a);
      assert.deepEqual(yield* logout('a'), a);
      assert.deepEqual(runs, ['one:/held', 'logout:a', 'logout:b']);
    }),
  ));

test('a running mutation is never run again: not after its caller goes, nor once 256 newer requests pass it', () =>
  runScoped(
    Effect.gen(function* () {
      const { runs, release, approve, start } = yield* replayFixture;
      // Its caller going leaves the mutation running. A second caller keeps the request awaited,
      // so the newer requests evict it from the remembered ones while it runs.
      const gone = yield* start('held', '/held');
      const kept = yield* start('held', '/held');
      yield* Fiber.interrupt(gone);
      const newer = Array.from({ length: 300 }, (_, index) => `newer-${index}`);
      for (const id of newer) yield* approve(id, '/done');
      // A repeat, past the remembered requests, joins the run still going, and the input still
      // binds: a reuse is refused once the run it names settles.
      const repeat = yield* start('held', '/held');
      const reused = yield* start('held', '/other');
      yield* Deferred.succeed(release, undefined);
      assert.equal(failureTag(yield* Fiber.join(repeat)), 'succeeded');
      assert.deepEqual(yield* Fiber.join(kept), yield* Fiber.join(repeat));
      assert.equal(failureTag(yield* Fiber.join(reused)), 'RequestReusedError');
      assert.equal(runs.filter((run) => run === 'held:/held').length, 1);
      // A settled request among the last 256 still replays; one past them is forgotten.
      const before = runs.length;
      yield* approve(newer.at(-1)!, '/done');
      assert.equal(runs.length, before);
      yield* approve(newer[0]!, '/done');
      assert.equal(runs.length, before + 1);
    }),
  ));
