import { Effect, Fiber, FiberHandle, Option } from 'effect';

/**
 * Joins the step `handle` runs, or starts `step` in it when none runs. The step is the handle's,
 * not the caller's: a caller interrupted while it waits only stops waiting, and every other
 * caller still gets the step's outcome. Closing the handle's scope interrupts it.
 */
export const runOrJoin = <A, E, R>(
  handle: FiberHandle.FiberHandle<A, E>,
  step: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const running = FiberHandle.getUnsafe(handle);
    if (Option.isSome(running)) return Fiber.join(running.value);
    // The step's first instruction marks it as ours: `run` starts it immediately, so this is set
    // before `run` returns. Reading the handle after `run` instead could see a later step.
    let mine = false;
    const owned = Effect.suspend(() => {
      mine = true;
      return step;
    });
    return Effect.flatMap(FiberHandle.run(handle, owned, { onlyIfMissing: true }), (started) => {
      if (mine) return Fiber.join(started);
      // Another caller's step started meanwhile: join it, or start again if it has ended.
      const other = FiberHandle.getUnsafe(handle);
      return Option.isSome(other) ? Fiber.join(other.value) : runOrJoin(handle, step);
    });
  });
