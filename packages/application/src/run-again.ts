import { Effect, Fiber, FiberSet, HashMap, Option, SynchronizedRef, type Scope } from 'effect';

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

/** A key's run, and whether a call asked it to go once more. */
type Run<E> = {
  /** Tells this run from a later one of the same key. */
  readonly id: object;
  readonly fiber: Fiber.Fiber<void, E>;
  readonly again: boolean;
};

/** Keyed run-again: the chat list's reloads and the editor's checkout refreshes. */
export const makeRunAgain = <K, E = never>(): Effect.Effect<RunAgain<K, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const fibers = yield* FiberSet.make<void, E>();
    /** Each key's run while it is going: a run leaves only by its own last take or interruption. */
    const runs = yield* SynchronizedRef.make(HashMap.empty<K, Run<E>>());
    const owned = (map: HashMap.HashMap<K, Run<E>>, key: K, id: object) =>
      Option.filter(HashMap.get(map, key), (run) => run.id === id);
    /**
     * Takes the run's ask to go again, or, with none, ends the run in the same step, so a later
     * call either sets an ask this run sees or finds no run and starts one.
     */
    const takeAgain = (key: K, id: object) =>
      SynchronizedRef.modify(runs, (map) =>
        Option.match(owned(map, key, id), {
          onNone: () => [false, map] as const,
          onSome: (run) =>
            run.again
              ? ([true, HashMap.set(map, key, { ...run, again: false })] as const)
              : ([false, HashMap.remove(map, key)] as const),
        }),
      );
    // A failed or interrupted run removes its own entry, never a successor's.
    const leave = (key: K, id: object) =>
      SynchronizedRef.update(runs, (map) =>
        Option.isSome(owned(map, key, id)) ? HashMap.remove(map, key) : map,
      );
    const loop = (key: K, id: object, once: Effect.Effect<void, E>) =>
      Effect.gen(function* () {
        do yield* once;
        while (yield* takeAgain(key, id));
      }).pipe(Effect.onError(() => leave(key, id)));
    return {
      run: (key, once, { latest = false } = {}) =>
        Effect.flatMap(
          SynchronizedRef.modifyEffect(runs, (map) => {
            const running = HashMap.get(map, key);
            if (Option.isSome(running)) {
              const run = running.value;
              return Effect.succeed([
                run.fiber,
                latest ? HashMap.set(map, key, { ...run, again: true }) : map,
              ] as const);
            }
            // The run starts once recorded, so its first take finds it.
            const id = {};
            return Effect.map(
              FiberSet.run(fibers, loop(key, id, once), { startImmediately: false }),
              (fiber) => [fiber, HashMap.set(map, key, { id, fiber, again: false })] as const,
            );
          }),
          Fiber.join,
        ),
      // A run interrupted before it started never ran `loop`'s cleanup, so its entry goes here.
      interrupt: (key) =>
        Effect.flatMap(
          SynchronizedRef.modify(runs, (map) => [HashMap.get(map, key), HashMap.remove(map, key)]),
          Option.match({ onNone: () => Effect.void, onSome: (run) => Fiber.interrupt(run.fiber) }),
        ),
    } satisfies RunAgain<K, E>;
  });
