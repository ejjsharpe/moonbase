import { Effect } from 'effect';

/**
 * Runs synchronous work that may throw, such as a filesystem call or a check, as an Effect whose
 * failure is what it threw, so callers can recover from it like any other failure.
 */
export const attempt = <A>(work: () => A): Effect.Effect<A, unknown> =>
  Effect.try({ try: work, catch: (error) => error });
