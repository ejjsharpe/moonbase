import { Cause, Duration, Effect, Schedule } from 'effect';
import { streamLimits } from './protocol.ts';

/**
 * How a dropped connection or watch is tried again: after each delay in `streamLimits.reconnectMs`
 * while its failure `isRetryable`, starting the delays over once an attempt has stayed up for
 * `streamLimits.renewMs`. `onRetry` runs before each wait, and `onStop` once, when it gives up.
 */
export const reconnectSchedule = <E, R = never>(options: {
  isRetryable(error: E): boolean;
  onRetry?(error: E): Effect.Effect<void, never, R>;
  onStop?(error: E): Effect.Effect<void, never, R>;
}): Schedule.Schedule<number, E, never, R> =>
  Schedule.fromStep(
    Effect.sync(() => {
      let failures = 0,
        retriedAt: number | undefined;
      return (now: number, error: E) => {
        if (retriedAt !== undefined && now - retriedAt >= streamLimits.renewMs) failures = 0;
        const delay = streamLimits.reconnectMs[failures];
        if (!options.isRetryable(error) || delay === undefined)
          return Effect.andThen(options.onStop?.(error) ?? Effect.void, Cause.done(failures));
        failures++;
        retriedAt = now + delay;
        return Effect.as(options.onRetry?.(error) ?? Effect.void, [
          failures,
          Duration.millis(delay),
        ] as [number, Duration.Duration]);
      };
    }),
  );
