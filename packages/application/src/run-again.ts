import { Effect, Fiber, FiberMap, HashSet, Option, Ref, type Scope } from 'effect';

/** Work run one at a time per key, which a call joins or has run once more after. */
export type RunAgain<K, E> = {
  /**
   * Runs `once` for `key` unless a run of it is going, which the call joins instead. With
   * `latest` (the call needs a run that begins after it), that run goes once more after. A
   * failure or interruption ends the run, and its callers with it.
   */
  readonly run: (
    key: K,
    once: Effect.Effect<void, E>,
    options?: { readonly latest?: boolean },
  ) => Effect.Effect<void, E>;
  /** Interrupts the key's run. */
  readonly interrupt: (key: K) => Effect.Effect<void>;
};

/** Keyed run-again: the chat list's reloads and the editor's checkout refreshes. */
export const makeRunAgain = <K, E = never>(): Effect.Effect<RunAgain<K, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const runs = yield* FiberMap.make<K, void, E>();
    /** Keys a call asked to run again since their run last began a pass. */
    const asked = yield* Ref.make(HashSet.empty<K>());
    const take = (key: K) =>
      Ref.modify(asked, (keys) => [HashSet.has(keys, key), HashSet.remove(keys, key)] as const);
    const loop = (key: K, once: Effect.Effect<void, E>) =>
      Effect.gen(function* () {
        while (yield* take(key)) yield* once;
      }).pipe(Effect.onError(() => Ref.update(asked, HashSet.remove(key))));
    // Finding the key's run and starting one if there is none happen in one synchronous step.
    // The run starts once recorded, so a call it makes meanwhile joins it.
    const join = (key: K, once: Effect.Effect<void, E>) =>
      Effect.suspend(() => {
        const running = FiberMap.getUnsafe(runs, key);
        return Effect.flatMap(
          Option.isSome(running)
            ? Effect.succeed(running.value)
            : FiberMap.run(runs, key, loop(key, once), { startImmediately: false }),
          Fiber.join,
        );
      });
    return {
      run: (key, once, { latest = false } = {}) =>
        Effect.gen(function* () {
          if (latest || !FiberMap.hasUnsafe(runs, key)) yield* Ref.update(asked, HashSet.add(key));
          // A run that ended just as the call asked leaves its ask: the call starts the next.
          do yield* join(key, once);
          while (HashSet.has(yield* Ref.get(asked), key));
        }),
      interrupt: (key) => FiberMap.remove(runs, key),
    } satisfies RunAgain<K, E>;
  });
