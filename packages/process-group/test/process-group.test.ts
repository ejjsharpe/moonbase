import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Effect, Exit, Fiber, Schedule, Scope } from 'effect';
import {
  ProcessGroupError,
  ProcessGroups,
  type ProcessGroupCloseStop,
  type SignalGroup,
} from '../src/index.ts';

const stopTiming = { termGrace: '100 millis', deadline: '400 millis' } as const;
const running = ['-e', 'setInterval(() => {}, 1000)'];
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
type Outcome = 'system' | 'delivered' | 'ESRCH' | 'EPERM';
/** A group signal whose outcome `decide` picks per signal, recording each one sent. */
const tracedSignal = (decide: (signal: NodeJS.Signals | 0) => Outcome) => {
  const sent: (NodeJS.Signals | 0)[] = [];
  const signalGroup: SignalGroup = (groupId, signal) => {
    sent.push(signal);
    const outcome = decide(signal);
    if (outcome === 'system') process.kill(-groupId, signal);
    else if (outcome !== 'delivered')
      throw Object.assign(new Error(`Controlled ${outcome}`), { code: outcome });
  };
  return { sent, signalGroup };
};
const runWith = <A, E>(signalGroup: SignalGroup, effect: Effect.Effect<A, E, ProcessGroups>) =>
  Effect.runPromise(effect.pipe(Effect.provide(ProcessGroups.layerWith(signalGroup))));
const spawnGroup = (args: string[], stopOnClose: ProcessGroupCloseStop = 'always') =>
  Effect.gen(function* () {
    const groups = yield* ProcessGroups;
    return yield* groups.spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      stopTiming,
      stopOnClose,
    });
  });
const spawnRunning = spawnGroup(running);
/** Kills `pid` if it is still running, for cleanup that must happen even when a test fails. */
const killIfAlive = (pid: number | undefined) => {
  if (pid !== undefined && isAlive(pid)) process.kill(pid, 'SIGKILL');
};
const until = (done: () => boolean) =>
  Effect.repeat(Effect.sync(done), { schedule: Schedule.spaced('5 millis'), until: (d) => d });

test('once ESRCH is seen, a later stop or signal never reaches a group that reuses the ID', async () => {
  let reused = false;
  const { sent, signalGroup } = tracedSignal(() => (reused ? 'delivered' : 'ESRCH'));
  await runWith(
    signalGroup,
    Effect.scoped(
      Effect.gen(function* () {
        const group = yield* spawnRunning;
        const pid = group.process.pid!;
        // The first stop sees the group gone, then waits for pipes the leader still holds.
        const first = yield* Effect.forkChild(group.stop);
        yield* until(() => sent.length > 0);
        yield* Fiber.interrupt(first);
        reused = true;
        process.kill(pid, 'SIGKILL');
        yield* group.exit;
        yield* group.signal('SIGTERM');
        yield* group.stop;
        assert.deepEqual(sent, [0]);
      }),
    ),
  );
  assert.deepEqual(sent, [0]);
});

test('EPERM is signalled again in SIGTERM’s turn, SIGKILL is always tried, and an unconfirmed stop keeps its typed failure through a bounded scope close', async () => {
  const denied = tracedSignal((signal) => (signal === 'SIGTERM' ? 'EPERM' : 'system'));
  await runWith(
    denied.signalGroup,
    Effect.scoped(
      Effect.gen(function* () {
        const group = yield* spawnRunning;
        yield* group.stop;
        assert((yield* group.exit).signal === 'SIGKILL');
        assert(denied.sent.filter((signal) => signal === 'SIGTERM').length > 1);
        assert(!isAlive(group.process.pid!));
      }),
    ),
  );

  const unconfirmed = tracedSignal(() => 'EPERM');
  let pid: number | undefined;
  try {
    // A defect, rather than the typed failure, would reject the run; a close that waits for the
    // leader would never end it.
    const pending = delay(5_000, undefined, { ref: false }).then(() => {
      throw new Error('The scope close stayed pending.');
    });
    const run = runWith(
      unconfirmed.signalGroup,
      Effect.flip(
        Effect.scoped(
          Effect.gen(function* () {
            const group = yield* spawnRunning;
            pid = group.process.pid!;
            // The stop has given up once it returns; the close then tries once more.
            yield* group.stop;
          }),
        ),
      ),
    );
    const failure = await Promise.race([run, pending]);
    // The scope close ended with the group still running, and kept the stop's typed failure.
    assert(isAlive(pid!));
    assert(failure instanceof ProcessGroupError && failure.reason === 'teardown');
    // SIGKILL was tried by the stop and again by the close.
    assert(unconfirmed.sent.filter((signal) => signal === 'SIGKILL').length > 1);
  } finally {
    killIfAlive(pid);
  }
});

test('closing the scope stops the group as stopOnClose says, even in a scope already closed', async () => {
  const { sent, signalGroup } = tracedSignal(() => 'system');
  await runWith(
    signalGroup,
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      yield* Scope.close(scope, Exit.void);
      const group = yield* Scope.provide(scope)(spawnRunning);
      assert.equal((yield* group.exit).signal, 'SIGTERM');
      assert(!isAlive(group.process.pid!));
    }),
  );

  // `while-open`: a member of the group still holding stdout after the leader exited is stopped.
  let member: number | undefined;
  try {
    await runWith(
      signalGroup,
      Effect.scoped(
        Effect.gen(function* () {
          const group = yield* spawnGroup(
            [
              '-e',
              `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'ignore'] }); process.stdout.write(c.pid + '\\n', () => process.exit(0));`,
            ],
            'while-open',
          );
          let printed = '';
          group.process.stdout!.on('data', (chunk: Buffer) => {
            printed += chunk.toString();
          });
          yield* group.exit;
          yield* until(() => printed.includes('\n'));
          member = Number(printed.trim());
          assert(isAlive(member));
        }),
      ),
    );
    assert(!isAlive(member!));
  } finally {
    killIfAlive(member);
  }

  // `while-open` with every pipe closed leaves the group unsignalled.
  sent.length = 0;
  await runWith(
    signalGroup,
    Effect.scoped(Effect.flatMap(spawnGroup(['-e', ''], 'while-open'), (group) => group.closed)),
  );
  assert.deepEqual(sent, []);
});
