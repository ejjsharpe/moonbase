import { Cause, Effect } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';

/**
 * Keeps an `ApplicationError` and replaces anything else with `fallback`, so an unknown failure's
 * diagnostics never reach a user, a log or another process.
 */
export function normalizeApplicationError(
  value: unknown,
  fallback?: ApplicationError,
): ApplicationError {
  if (ApplicationError.is(value)) return value;
  return (
    fallback ?? new ApplicationError({ code: 'Unavailable', message: 'Application effect failed' })
  );
}

/**
 * The `ApplicationError` a failed Effect ends with: `Cancelled` when it was only interrupted, and
 * its failure when that is a single `ApplicationError`. Several failures (a command's and its
 * cleanup's) keep the first application error's code and target, so `Uncertain` is never lost,
 * and join each one's normalized message. With no application error it is `fallback`.
 */
export function toApplicationError(
  cause: Cause.Cause<unknown>,
  fallback?: ApplicationError,
): ApplicationError {
  if (cause.reasons.length > 0 && Cause.hasInterruptsOnly(cause))
    return new ApplicationError({ code: 'Cancelled', message: 'Command cancelled' });
  const failures = cause.reasons.flatMap((reason) => {
    if (Cause.isFailReason(reason)) return [reason.error];
    if (Cause.isDieReason(reason)) return [reason.defect];
    return [];
  });
  const typed = failures.find(ApplicationError.is);
  if (failures.length === 1 || !typed) return normalizeApplicationError(typed, fallback);
  return new ApplicationError({
    code: typed.code,
    target: typed.target,
    message: failures
      .map((failure) => normalizeApplicationError(failure, fallback).message)
      .join('; '),
  });
}

/** Normalize release failures before Effect combines them with a command's cause. */
export const releaseResource = (release: () => void | Promise<void>): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async () => {
      await release();
    },
    catch: (error) =>
      normalizeApplicationError(
        error,
        new ApplicationError({
          code: 'Unavailable',
          message: 'Application resource cleanup failed',
        }),
      ),
  }).pipe(Effect.orDie);
