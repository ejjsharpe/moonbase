import { Effect, RcMap, Semaphore, type Scope } from 'effect';

/**
 * Runs work one at a time per key, in the order it arrives. The wait for the key is as
 * interruptible as the caller unless `cancellableWait` makes it interruptible where the work
 * itself is not. A key's lock is dropped once nothing holds or waits for it.
 */
export type KeyedLock = <A, E, R>(
  key: string,
  work: Effect.Effect<A, E, R>,
  options?: { readonly cancellableWait?: boolean },
) => Effect.Effect<A, E, Exclude<R, Scope.Scope>>;

/** A keyed lock that lives as long as the scope it is made in. */
export const makeKeyedLock: Effect.Effect<KeyedLock, never, Scope.Scope> = Effect.map(
  RcMap.make({ lookup: (_key: string) => Semaphore.make(1) }),
  (locks) =>
    (key, work, { cancellableWait = false } = {}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const lock = yield* RcMap.get(locks, key);
          const take = lock.takeScoped(1);
          yield* cancellableWait ? Effect.interruptible(take) : take;
          return yield* work;
        }),
      ),
);
