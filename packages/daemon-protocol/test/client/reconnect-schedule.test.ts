import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Duration, Effect, Exit, Schedule } from 'effect';
import { streamLimits } from '../../src/client/protocol.ts';
import { reconnectSchedule } from '../../src/client/reconnect-schedule.ts';

/** The delays a schedule gives failing attempts, each ending `took` after the last retry. */
const delaysOf = (upSince: (now: number) => number | undefined, took: number) =>
  Effect.runPromise(
    Effect.gen(function* () {
      let now = 0,
        stopped = false;
      const schedule = reconnectSchedule<string>({
        upSince: Effect.sync(() => upSince(now)),
        isRetryable: () => true,
        onStop: () => Effect.sync(() => void (stopped = true)),
      });
      const step = yield* Schedule.toStep(schedule);
      const delays: number[] = [];
      for (let attempt = 0; attempt < 8; attempt++) {
        now += took;
        const exit = yield* Effect.exit(step(now, 'failed'));
        if (Exit.isFailure(exit)) break;
        const delay = Duration.toMillis(exit.value[1]);
        delays.push(delay);
        now += delay;
      }
      return { delays, stopped };
    }),
  );

test('the reconnect budget renews only for an attempt that stayed up, not one that only took as long', async () => {
  // Attempts that never came up stop after the budget, however long each took to fail.
  assert.deepEqual(await delaysOf(() => undefined, streamLimits.renewMs * 2), {
    delays: streamLimits.reconnectMs,
    stopped: true,
  });
  // One that came up as it started and stayed up `renewMs` starts the delays over each time.
  const renewed = await delaysOf((now) => now - streamLimits.renewMs, streamLimits.renewMs);
  assert.equal(renewed.stopped, false);
  assert.deepEqual(new Set(renewed.delays), new Set([streamLimits.reconnectMs[0]]));
});
