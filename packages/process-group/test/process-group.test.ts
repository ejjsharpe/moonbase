import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Exit, Fiber, Schedule, Scope } from 'effect';
import { ProcessGroupError, ProcessGroups, type SignalGroup } from '../src/index.ts';

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
const spawnGroup = (args: string[]) =>
  Effect.gen(function* () {
    const groups = yield* ProcessGroups;
    return yield* groups.spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      stopTiming,
    });
  });
const spawnRunning = spawnGroup(running);
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

test('EPERM is signalled again in SIGTERM’s turn, SIGKILL is always tried, and an unconfirmed stop fails its scope close', async () => {
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
  await runWith(
    unconfirmed.signalGroup,
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const group = yield* Scope.provide(scope)(spawnRunning);
      const pid = group.process.pid!;
      const stopped = yield* Effect.flip(group.stop);
      assert(stopped instanceof ProcessGroupError && stopped.reason === 'teardown');
      assert(unconfirmed.sent.includes('SIGKILL'));
      // Closing tries again, then keeps the group until its leader has exited.
      const kills = unconfirmed.sent.length;
      const closing = yield* Effect.forkChild(Effect.exit(Scope.close(scope, Exit.void)));
      yield* until(() => unconfirmed.sent.slice(kills).includes('SIGKILL'));
      assert(isAlive(pid));
      process.kill(pid, 'SIGKILL');
      const closed = yield* Fiber.join(closing);
      assert(yield* group.hasExited);
      assert(Exit.isFailure(closed));
    }),
  );
});

test('closing the scope stops a running group, even in a scope already closed, and leaves one whose leader exited unsignalled', async () => {
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
  sent.length = 0;
  await runWith(
    signalGroup,
    Effect.scoped(
      Effect.gen(function* () {
        const group = yield* spawnGroup(['-e', '']);
        yield* group.closed;
      }),
    ),
  );
  assert.deepEqual(sent, []);
});
