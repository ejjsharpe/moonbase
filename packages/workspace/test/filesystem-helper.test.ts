import assert from 'node:assert/strict';
import { closeSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { Deferred, Effect, Fiber } from 'effect';
import { ProcessGroups } from '@moonbase/process-group';
import { makeFilesystemHelper } from '../src/filesystem-helper.ts';

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a run interrupted just after its helper spawned still stops the helper', async () => {
  const fd = openSync(tmpdir(), 'r');
  let pid: number | undefined;
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const groups = yield* ProcessGroups;
        const spawned = yield* Deferred.make<number>();
        const proceed = yield* Deferred.make<void>();
        // Holds the run right after the spawn returns, where an interruption used to leave the
        // started helper without the run's stop.
        const helper = makeFilesystemHelper(process.execPath, {
          spawn: (executable, args, options) =>
            Effect.tap(groups.spawn(executable, args, options), (group) =>
              Effect.andThen(
                Deferred.succeed(spawned, group.process.pid!),
                Deferred.await(proceed),
              ),
            ),
        });
        const run = yield* Effect.forkChild(
          helper.run(['-e', 'setInterval(() => {}, 1000)'], { fd }),
        );
        pid = yield* Deferred.await(spawned);
        const interrupted = yield* Effect.forkChild(Fiber.interrupt(run));
        yield* Effect.yieldNow;
        yield* Deferred.succeed(proceed, undefined);
        yield* Fiber.join(interrupted);
        assert(!isAlive(pid));
      }).pipe(Effect.provide(ProcessGroups.layer)),
    );
  } finally {
    if (pid !== undefined && isAlive(pid)) process.kill(pid, 'SIGKILL');
    closeSync(fd);
  }
});
