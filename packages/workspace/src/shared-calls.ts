import { Deferred, Effect } from 'effect';
import type { CancelledError } from '@moonbase/contracts/errors';
import { WorkspaceConflictError } from '@moonbase/contracts/workspace-host-errors';
import { asSharedOutcome } from './owned-work.ts';
import { same } from './validation.ts';

/**
 * Calls in flight by key, so a duplicate made while one runs shares its outcome instead of
 * starting a second. A duplicate whose first call was cancelled is `Cancelled` too, and one with a
 * different payload under the same key is refused as a `Conflict`.
 */
export type SharedCalls<A, E> = <R>(
  key: string,
  payload: unknown,
  /** The call's name, for the `Cancelled` a duplicate gets. */
  operation: string,
  /** Starts the call. It runs synchronously, in the same step that finds no call in flight. */
  start: () => Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | CancelledError | WorkspaceConflictError, R>;

export const makeSharedCalls = <A, E>(): SharedCalls<A, E> => {
  const running = new Map<
    string,
    { payload: unknown; outcome: Deferred.Deferred<A, E | CancelledError> }
  >();
  return <R>(
    key: string,
    payload: unknown,
    operation: string,
    start: () => Effect.Effect<A, E, R>,
  ) =>
    Effect.suspend((): Effect.Effect<A, E | CancelledError | WorkspaceConflictError, R> => {
      // Finding the call in flight, or starting this one and registering it, is one synchronous
      // step, so two copies never both miss each other.
      const first = running.get(key);
      if (first)
        return same(first.payload, payload)
          ? Effect.interruptible(Deferred.await(first.outcome))
          : Effect.fail(new WorkspaceConflictError({ conflict: 'request-payload' }));
      const work = start();
      const outcome = Deferred.makeUnsafe<A, E | CancelledError>();
      running.set(key, { payload, outcome });
      return work.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            running.delete(key);
            Deferred.doneUnsafe(outcome, asSharedOutcome(exit, operation));
          }),
        ),
      );
    });
};
