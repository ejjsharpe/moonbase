import { normalizeApplicationError, releaseResource } from '@moonbase/effect';
import { Cause, Effect, Exit, Fiber, FiberSet } from 'effect';
import { ApplicationError } from '@moonbase/contracts/workspace';
import { fail } from '@moonbase/contracts/errors';

/** Runs every release in order, even after one fails, then fails with all their failures. */
export const releaseAll = (releases: readonly Effect.Effect<void>[]): Effect.Effect<void> =>
  Effect.flatMap(Effect.forEach(releases, Effect.exit), (exits) => {
    const failures = exits.flatMap((exit) => (Exit.isFailure(exit) ? [exit.cause] : []));
    return failures.length
      ? Effect.failCause(failures.reduce((all, cause) => Cause.combine(all, cause)))
      : Effect.void;
  });

/** What admission needs of its owner: whether it still accepts work, and where work is tracked. */
export type AdmissionOwner = {
  readonly closed: boolean;
  readonly signals: Set<AbortController>;
  readonly operations: FiberSet.FiberSet<unknown, ApplicationError>;
};

/**
 * Runs `fn` as owned work: it is refused once the owner is closed, aborted when its caller is
 * interrupted or the owner closes, and settles before the owner releases its resources.
 * `surround` wraps the work, for a lease; `abandoned` receives a result nobody will take.
 */
export function admit<A>(
  owner: AdmissionOwner,
  fn: (signal: AbortSignal) => Promise<A>,
  persistence = false,
  surround?: (
    signal: AbortSignal,
    work: Effect.Effect<A, ApplicationError>,
  ) => Effect.Effect<A, ApplicationError>,
  abandoned?: (result: A) => void,
): Effect.Effect<A, ApplicationError> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      if (owner.closed)
        return yield* Effect.fail(
          new ApplicationError({ code: 'Unavailable', message: 'Workspace scope is closed.' }),
        );
      const abort = new AbortController();
      owner.signals.add(abort);
      let result: { value: A } | undefined;
      const work = Effect.tryPromise({
        try: async () => {
          if (abort.signal.aborted)
            fail('Cancelled', 'Workspace command cancelled before admission.');
          const value = await fn(abort.signal);
          result = { value };
          return value;
        },
        catch: (error) =>
          normalizeApplicationError(
            error,
            new ApplicationError({
              code: persistence ? 'Persistence' : 'Unavailable',
              message: 'Application effect failed',
            }),
          ),
      });
      // Raw OS Promises must settle before the lease, descriptors or Store can be released.
      const owned = (surround ? surround(abort.signal, work) : work).pipe(
        Effect.uninterruptible,
        Effect.ensuring(Effect.sync(() => owner.signals.delete(abort))),
      );
      const fiber = yield* FiberSet.run(owner.operations, owned);
      return yield* restore(Fiber.join(fiber)).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            abort.abort();
            if (abandoned) {
              yield* Fiber.await(fiber);
              if (result) yield* releaseResource(() => abandoned(result!.value));
            }
          }),
        ),
      );
    }),
  );
}
