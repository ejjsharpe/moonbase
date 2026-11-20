import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Exit, Fiber, Latch, Ref, type Scope } from 'effect';
import { makeRunAgain } from '../src/run-again.ts';

/** A run whose passes each wait on `gate` once started, counting them. */
const passes = Effect.gen(function* () {
  const count = yield* Ref.make(0);
  const started = yield* Latch.make(false);
  const gate = yield* Latch.make(false);
  const once = Effect.gen(function* () {
    yield* Ref.update(count, (n) => n + 1);
    yield* started.open;
    yield* gate.await;
  });
  return { count, started, gate, once };
});

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect));

test('a call during a run joins it, and a latest one runs it once more after', () =>
  run(
    Effect.gen(function* () {
      const runAgain = yield* makeRunAgain<string>();
      const { count, started, gate, once } = yield* passes;
      const first = yield* Effect.forkChild(runAgain.run('k', once));
      yield* started.await;
      const joined = yield* Effect.forkChild(runAgain.run('k', once));
      yield* Effect.yieldNow;
      yield* gate.open;
      yield* Fiber.join(first);
      yield* Fiber.join(joined);
      assert.equal(yield* Ref.get(count), 1);
      yield* gate.close;
      yield* started.close;
      const second = yield* Effect.forkChild(runAgain.run('k', once));
      yield* started.await;
      const latest = yield* Effect.forkChild(runAgain.run('k', once, { latest: true }));
      const again = yield* Effect.forkChild(runAgain.run('k', once, { latest: true }));
      yield* Effect.yieldNow;
      yield* gate.open;
      yield* Fiber.joinAll([second, latest, again]);
      // The run's pass and one more for both latest calls.
      assert.equal(yield* Ref.get(count), 3);
    }),
  ));

test('interrupting a caller leaves the shared run going, and interrupting the key ends it and its callers', () =>
  run(
    Effect.gen(function* () {
      const runAgain = yield* makeRunAgain<string>();
      const { count, started, gate, once } = yield* passes;
      const leaving = yield* Effect.forkChild(runAgain.run('k', once));
      yield* started.await;
      const staying = yield* Effect.forkChild(runAgain.run('k', once));
      yield* Fiber.interrupt(leaving);
      yield* gate.open;
      yield* Fiber.join(staying);
      assert.equal(yield* Ref.get(count), 1, 'the run finished for the caller that stayed');
      yield* gate.close;
      yield* started.close;
      // The run's interruption is held in its finalizer, the window where it is still stopping.
      const stopping = yield* Latch.make(false);
      const stopped = yield* Latch.make(false);
      const ending = once.pipe(
        Effect.onInterrupt(() => Effect.andThen(stopping.open, stopped.await)),
      );
      const ended = yield* Effect.forkChild(runAgain.run('k', ending));
      yield* started.await;
      const joined = yield* Effect.forkChild(runAgain.run('k', once, { latest: true }));
      yield* Effect.yieldNow;
      const interrupting = yield* Effect.forkChild(runAgain.interrupt('k'));
      yield* stopping.await;
      // A call made while the run stops starts a pass of its own, not one more of the ended run.
      yield* gate.open;
      yield* runAgain.run('k', once, { latest: true });
      assert.equal(yield* Ref.get(count), 3);
      assert.equal(interrupting.pollUnsafe(), undefined, '`interrupt` waits for the run to stop');
      yield* stopped.open;
      yield* Fiber.join(interrupting);
      assert(Exit.hasInterrupts(yield* Fiber.await(ended)));
      assert(Exit.hasInterrupts(yield* Fiber.await(joined)));
      // Nothing is left asked: the next call runs one pass.
      yield* runAgain.run('k', once);
      assert.equal(yield* Ref.get(count), 4);
    }),
  ));

test('a failed run fails its callers', () =>
  run(
    Effect.gen(function* () {
      const runAgain = yield* makeRunAgain<string, string>();
      const gate = yield* Latch.make(false);
      const started = yield* Latch.make(false);
      const failing = Effect.andThen(
        Effect.andThen(started.open, gate.await),
        Effect.fail('broken'),
      );
      const first = yield* Effect.forkChild(runAgain.run('k', failing));
      yield* started.await;
      const joined = yield* Effect.forkChild(runAgain.run('k', failing));
      yield* Effect.yieldNow;
      yield* gate.open;
      assert.deepEqual(yield* Fiber.await(first), Exit.fail('broken'));
      assert.deepEqual(yield* Fiber.await(joined), Exit.fail('broken'));
    }),
  ));
