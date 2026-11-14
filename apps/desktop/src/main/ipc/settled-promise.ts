import { Effect } from 'effect';
import { normalizeApplicationError } from '@moonbase/effect';
import type { ApplicationError } from '@moonbase/contracts/errors';

/**
 * Native work as an Effect that, when interrupted, aborts its signal and then waits for it to
 * settle, so whatever held the request (a document closing, Quit) knows the OS action is over.
 * `onLateSettle` receives what work interrupted after starting still produced.
 */
export const settledPromise = <A>(
  run: (signal: AbortSignal) => Promise<A>,
  onLateSettle?: (value: A) => Promise<unknown> | unknown,
) =>
  Effect.callback<A, ApplicationError>((resume, signal) => {
    const work = run(signal);
    work.then(
      (value) => resume(Effect.succeed(value)),
      (error: unknown) => resume(Effect.fail(normalizeApplicationError(error))),
    );
    return Effect.promise(() =>
      work.then(
        (value) => onLateSettle?.(value),
        () => {},
      ),
    );
  });
