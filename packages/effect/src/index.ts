import { Effect } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';

// Only owner-authored application errors carry diagnostics safe for public clients.
export const safeApplicationFailure = (value: unknown, message: string): ApplicationError =>
  ApplicationError.is(value) ? value : new ApplicationError({ code: 'Unavailable', message });

export const normalizeApplicationError = (value: unknown): ApplicationError =>
  safeApplicationFailure(value, 'Application effect failed');

/** Normalize release failures before Effect combines them with a command's cause. */
export const releaseResource = (release: () => void | Promise<void>): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async () => {
      await release();
    },
    catch: (error) => safeApplicationFailure(error, 'Application resource cleanup failed'),
  }).pipe(Effect.orDie);
