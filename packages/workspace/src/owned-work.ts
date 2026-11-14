import { Cause, Effect, Exit, Fiber, FiberSet, Option } from 'effect';
import {
  WorkspaceStoreError,
  WorkspaceUnavailableError,
} from '@moonbase/contracts/workspace-host-errors';
import { isWorkspaceError, type WorkspaceError } from '@moonbase/contracts/workspace-errors';
import type { WorkspaceFailure } from './attempt.ts';
import { SystemFailure } from './system-failures.ts';

/**
 * The workspace error for a failure: the workspace's own errors as they are, and a fixed one for
 * what a helper or system call reported (a store failure for work on the store), so their
 * diagnostics never reach a client.
 */
export const asWorkspaceError = <E extends WorkspaceError>(
  failure: WorkspaceFailure | E,
  persistence: boolean,
): WorkspaceError => {
  if (isWorkspaceError(failure)) return failure;
  return persistence
    ? new WorkspaceStoreError({ failure: 'failed' })
    : new WorkspaceUnavailableError({ cause: 'failed' });
};

/**
 * `effect` failing only with workspace errors: a failure as its error, a defect (a bug) as the
 * same fixed error, and an interruption kept as it is.
 */
export const withWorkspaceErrors = <A, R>(
  effect: Effect.Effect<A, WorkspaceFailure, R>,
  persistence = false,
): Effect.Effect<A, WorkspaceError, R> =>
  Effect.catchCause(effect, (cause) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>);
    const failure = Cause.findErrorOption(cause);
    return Effect.fail(
      asWorkspaceError(
        Option.isSome(failure) ? failure.value : new SystemFailure({ code: undefined, cause }),
        persistence,
      ),
    );
  });

/**
 * Runs owned work in `operations`, so closing its owner stops it and waits for it. A caller that
 * cancels ends interrupted and asks the work to stop without waiting for it; the work keeps what
 * it holds until it ends. `abandoned` undoes a result nobody will receive. Work stopped while its
 * caller still waits (its owner is closing) fails as `Unavailable`.
 */
export const runOwned = <A, E>(
  operations: FiberSet.FiberSet<unknown, E>,
  work: Effect.Effect<A, E>,
  abandoned?: (result: A) => Effect.Effect<void, unknown>,
): Effect.Effect<A, E | WorkspaceUnavailableError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      // What the work returned, kept for `abandoned` even when the work ends interrupted.
      let result: { value: A } | undefined;
      const fiber = yield* FiberSet.run(
        operations,
        Effect.uninterruptible(
          Effect.tap(work, (value) =>
            Effect.sync(() => {
              result = { value };
            }),
          ),
        ),
      );
      const exit = yield* restore(Fiber.await(fiber)).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            // Asked at once, so the work sees it at its next interruptible point.
            fiber.interruptUnsafe();
            if (!abandoned) return;
            yield* Fiber.await(fiber);
            if (result) yield* Effect.exit(abandoned(result.value));
          }),
        ),
      );
      if (Exit.isSuccess(exit)) return exit.value as A;
      if (Cause.hasInterruptsOnly(exit.cause))
        return yield* new WorkspaceUnavailableError({ cause: 'closed' });
      return yield* Effect.failCause(exit.cause);
    }),
  );
