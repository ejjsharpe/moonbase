import { Context, Deferred, Effect, Layer, type Scope } from 'effect';
import { overlaps } from '../validation.ts';

/** Paths of one checkout that a save, operation or `git init` holds while it runs. */
export type Lease = { checkoutId: string; paths: string[] };
type Held = Lease & { released: Deferred.Deferred<void> };

/**
 * The paths that running saves and operations hold. A new holder waits for every earlier one
 * whose paths overlap its own (`''` is the whole checkout); the journal then refuses work over
 * an unresolved earlier save or operation, so overlapping work never runs twice at once.
 */
export class Leases extends Context.Service<
  Leases,
  {
    /** Holds `lease` for the rest of the scope, after waiting (interruptibly) for overlaps. */
    hold(lease: Lease): Effect.Effect<void, never, Scope.Scope>;
    /** Whether anything holds paths of the checkout now. */
    isActive(checkoutId: string): boolean;
  }
>()('moonbase/workspace/Leases') {
  static readonly layer = Layer.sync(Leases, () => {
    const held = new Set<Held>();
    return {
      hold: (lease) =>
        Effect.gen(function* () {
          const earlier = yield* Effect.acquireRelease(
            Effect.sync(() => {
              const entry: Held = { ...lease, released: Deferred.makeUnsafe<void>() };
              const earlier = [...held].filter(
                (other) =>
                  other.checkoutId === lease.checkoutId && overlaps(lease.paths, other.paths),
              );
              held.add(entry);
              return { entry, earlier };
            }),
            ({ entry }) =>
              Effect.sync(() => {
                held.delete(entry);
                Deferred.doneUnsafe(entry.released, Effect.void);
              }),
          );
          yield* Effect.interruptible(
            Effect.forEach(earlier.earlier, (other) => Deferred.await(other.released), {
              discard: true,
            }),
          );
        }),
      isActive: (checkoutId) => [...held].some((entry) => entry.checkoutId === checkoutId),
    };
  });
}
