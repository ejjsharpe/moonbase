import { Cause, Clock, Duration, Effect, Schedule } from 'effect';

/**
 * How a watch that failed as `Unavailable` (a restarted daemon, say) is watched again: after each
 * backoff in `retryMs`, whose length caps the attempts, with the count renewed only when the failed
 * watch had stayed up for `healthyMs`. The chat transcript and the editor's checkouts share it.
 */
export const watchRetry = {
  retryMs: [1000, 5000, 15000],
  healthyMs: 15000,
} as const;

/** A watch's failure, and whether the watch had stayed up long enough to renew the attempts. */
export type WatchFailure<E> = { error: E; healthy: boolean };

/**
 * The shared watch-retry schedule: waits each backoff in `retryMs` while the failure is
 * retryable, renewing the count after a healthy watch, and stops after the last.
 */
export const watchRetrySchedule = <E>(
  retryMs: readonly number[],
  isRetryable: (error: E) => boolean,
) =>
  Schedule.fromStep(
    Effect.sync(() => {
      let attempt = 0;
      return (_now: number, failure: WatchFailure<E>) => {
        if (failure.healthy) attempt = 0;
        const delay = retryMs[attempt];
        if (!isRetryable(failure.error) || delay === undefined) return Cause.done(attempt);
        attempt++;
        return Effect.succeed([attempt, Duration.millis(delay)] as [number, Duration.Duration]);
      };
    }),
  );

/**
 * Runs `watch` and watches again on the shared schedule. `watch` is told whether it is a
 * re-watch and calls `up` once it is live; the last failure, or one that isn't retryable, ends it.
 */
export const retryWatch = <E, R>(
  watch: (rewatched: boolean, up: Effect.Effect<void>) => Effect.Effect<void, E, R>,
  options: {
    retryMs: readonly number[];
    healthyMs: number;
    isRetryable: (error: E) => boolean;
  },
): Effect.Effect<void, E, R> =>
  Effect.suspend(() => {
    let attempts = 0;
    const attempt = Effect.suspend(() => {
      const rewatched = attempts++ > 0;
      let upSince: number | undefined;
      const up = Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.sync(() => {
          upSince ??= now;
        }),
      );
      return watch(rewatched, up).pipe(
        Effect.catch((error) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            Effect.fail<WatchFailure<E>>({
              error,
              healthy: upSince !== undefined && now - upSince >= options.healthyMs,
            }),
          ),
        ),
      );
    });
    return attempt.pipe(
      Effect.retry(watchRetrySchedule(options.retryMs, options.isRetryable)),
      Effect.mapError((failure) => failure.error),
    );
  });
