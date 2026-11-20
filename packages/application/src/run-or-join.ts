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
    // `onlyIfMissing` never replaces a step another caller started meanwhile: join that one.
    return Effect.flatMap(FiberHandle.run(handle, step, { onlyIfMissing: true }), (started) =>
      Fiber.join(Option.getOrElse(FiberHandle.getUnsafe(handle), () => started)),
    );
  });
