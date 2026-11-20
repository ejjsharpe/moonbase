import { Cause, Duration, Effect, Schedule } from 'effect';
import { streamLimits } from './protocol.ts';

/**
 * How a dropped connection or watch is tried again: after each delay in `streamLimits.reconnectMs`
 * while its failure `isRetryable`, starting the delays over once the attempt that failed had been
 * up for `streamLimits.renewMs`. `upSince` is when the failing attempt came up (its socket opened,
 * its first value arrived), none if it never did: an attempt that only took that long, as one
 * against a host that times out does, renews nothing. `onRetry` runs before each wait, and
 * `onStop` once, when it gives up.
 */
export const reconnectSchedule = <E, R = never>(options: {
  upSince: Effect.Effect<number | undefined>;
  isRetryable(error: E): boolean;
  onRetry?(error: E): Effect.Effect<void, never, R>;
  onStop?(error: E): Effect.Effect<void, never, R>;
}): Schedule.Schedule<number, E, never, R> =>
  Schedule.fromStep(
    Effect.sync(() => {
      let failures = 0;
      return (now: number, error: E) =>
        Effect.flatMap(options.upSince, (since) => {
          if (since !== undefined && now - since >= streamLimits.renewMs) failures = 0;
          const delay = streamLimits.reconnectMs[failures];
          if (!options.isRetryable(error) || delay === undefined)
            return Effect.andThen(options.onStop?.(error) ?? Effect.void, Cause.done(failures));
          failures++;
          return Effect.as(options.onRetry?.(error) ?? Effect.void, [
            failures,
            Duration.millis(delay),
          ] as [number, Duration.Duration]);
        });
    }),
  );
