import assert from 'node:assert/strict';
import { closeSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { Deferred, Effect, Exit, Fiber, Layer, Stream } from 'effect';
import { TestClock } from 'effect/testing';
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

// The leader starts a member that ignores SIGTERM, reports its pid, then on SIGTERM writes a last
// row and exits cleanly, so its output can end before the time limit's stop has finished.
const cleanExitOnStop = `
const { spawn } = require('node:child_process');
const member = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); process.disconnect(); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
member.once('message', () => process.stdout.write(member.pid + '\\n'));
process.on('SIGTERM', () => process.stdout.write('last\\n', () => process.exit(0)));
setInterval(() => {}, 1000);
`;

test('a streamed run at its time limit fails and reaps its group though the helper exits cleanly', async () => {
  const fd = openSync(tmpdir(), 'r');
  let member: number | undefined;
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const helper = makeFilesystemHelper(process.execPath, yield* ProcessGroups);
        const started = yield* Deferred.make<number>();
        const run = yield* Effect.forkChild(
          Stream.runForEach(helper.lines(['-e', cleanExitOnStop], { fd }), (line) =>
            Deferred.succeed(started, Number(line)),
          ),
        );
        member = yield* Deferred.await(started);
        yield* TestClock.adjust('30 seconds');
        const exit = yield* Fiber.await(run);
        assert(Exit.isFailure(exit));
        const failure = exit.cause.reasons.find((reason) => reason._tag === 'Fail')?.error;
        assert.equal(failure?._tag, 'HelperFailure');
        assert.equal(failure.uncertain, true);
        assert(!isAlive(member));
      }).pipe(Effect.provide(Layer.merge(ProcessGroups.layer, TestClock.layer()))),
    );
  } finally {
    if (member !== undefined && isAlive(member)) process.kill(member, 'SIGKILL');
    closeSync(fd);
  }
});
