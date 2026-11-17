import { Clock, Duration, Effect, Schedule, Stream, SubscriptionRef } from 'effect';
import type { DaemonUse } from './daemon-stop.ts';

export type IdleOptions = {
  /** How long a local daemon may go unused before it stops. */
  idle: Duration.Duration;
  /** How often an otherwise unused daemon checks for active work. */
  poll: Duration.Duration;
  /** Whether chats have work running; a check that fails counts as work. */
  hasActiveWork: Effect.Effect<boolean, unknown>;
};

/**
 * Waits, on the Clock, until the daemon has been unused for `idle`: active work counts as use
 * whenever a check sees it. Work is checked every `poll`, or sooner when the wait ends first.
 */
const waitUnused = ({ idle, poll, hasActiveWork }: IdleOptions) =>
  Effect.gen(function* () {
    const idleMs = Duration.toMillis(idle),
      pollMs = Duration.toMillis(poll);
    let last = yield* Clock.currentTimeMillis;
    /** Checks for work and answers how long is left before the daemon is idle. */
    const remaining = Effect.gen(function* () {
      // Work that can't be ruled out keeps the daemon running.
      const active = yield* hasActiveWork.pipe(
        Effect.orElseSucceed(() => true),
        Effect.catchDefect(() => Effect.succeed(true)),
      );
      const now = yield* Clock.currentTimeMillis;
      if (active) last = now;
      return last + idleMs - now;
    });
    yield* Effect.sleep(Math.min(pollMs, idleMs));
    yield* Effect.repeat(remaining, {
      schedule: Schedule.forever.pipe(
        Schedule.modifyDelay(({ input }: Schedule.Metadata<unknown, number>) =>
          Effect.succeed(Math.min(pollMs, input)),
        ),
      ),
      until: (left) => left <= 0,
    });
  });

/**
 * Answers once nothing has used the daemon for `idle`: no use held in `use` (a client's request,
 * watch or workspace connection) and no active work. A use that begins restarts the wait, which
 * starts again from its end. `onIdle` decides, and answers whether the daemon then stopped; one
 * that did not (a use arrived meanwhile) leaves the wait to start again.
 */
export const waitForIdle = (
  use: SubscriptionRef.SubscriptionRef<DaemonUse>,
  options: IdleOptions,
  onIdle: Effect.Effect<boolean>,
) =>
  SubscriptionRef.changes(use).pipe(
    Stream.map((state) => state.users),
    Stream.changes,
    Stream.switchMap((users) =>
      users > 0 ? Stream.never : Stream.fromEffect(Effect.andThen(waitUnused(options), onIdle)),
    ),
    Stream.filter((stopped) => stopped),
    Stream.runHead,
    Effect.asVoid,
  );
