import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Deferred, Effect, Exit, Fiber, Latch, Ref, Scheduler, type Scope } from 'effect';
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

test('a latest call that arrives just after the run took its last ask still gets a pass', () =>
  // A call lands between a run's last take and its end only when the run yields to the scheduler
  // there, on using up its step budget. Growing the run's last pass one step at a time, under a
  // small budget, spends it at every point of that stretch once, the call waiting to go next.
  run(
    Effect.gen(function* () {
      let filler: Effect.Effect<void> = Effect.void;
      for (let size = 0; size < 64; size++) {
        filler = Effect.andThen(filler, Effect.void);
        const runAgain = yield* makeRunAgain<string>();
        const count = yield* Ref.make(0);
        const gate = yield* Deferred.make<void>();
        const pass = Ref.update(count, (n) => n + 1);
        const first = yield* Effect.forkChild(
          runAgain.run('k', Effect.andThen(Deferred.await(gate), Effect.andThen(pass, filler))),
        );
        yield* Effect.yieldNow;
        const late = yield* Effect.forkChild(
          Effect.gen(function* () {
            yield* Deferred.await(gate);
            const before = yield* Ref.get(count);
            yield* runAgain.run('k', pass, { latest: true });
            return before;
          }),
        );
        yield* Effect.yieldNow;
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(first);
        const before = yield* Fiber.join(late);
        assert((yield* Ref.get(count)) > before, `a pass began after the call (size ${size})`);
      }
    }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 64)),
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
      const ended = yield* Effect.forkChild(runAgain.run('k', once));
      yield* started.await;
      const joined = yield* Effect.forkChild(runAgain.run('k', once, { latest: true }));
      yield* Effect.yieldNow;
      yield* runAgain.interrupt('k');
      assert(Exit.hasInterrupts(yield* Fiber.await(ended)));
      assert(Exit.hasInterrupts(yield* Fiber.await(joined)));
      // Nothing is left asked: the next call runs one pass.
      yield* gate.open;
      yield* runAgain.run('k', once);
      assert.equal(yield* Ref.get(count), 3);
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
