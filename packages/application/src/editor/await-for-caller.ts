import { Effect, Fiber } from 'effect';

/**
 * Forks work only its caller wants and waits on it with `wait`: interrupting the caller
 * interrupts the work. The fork and the handler are installed uninterruptibly, so an interrupt
 * that reaches the caller while the work starts is still passed on; the work itself stays
 * interruptible. `fork` runs uninterruptibly, so it must only start the work, never wait.
 */
export const awaitForCaller = <A, E, R, B, E2, R2>(
  fork: Effect.Effect<Fiber.Fiber<A, E>, never, R>,
  wait: (fiber: Fiber.Fiber<A, E>) => Effect.Effect<B, E2, R2>,
): Effect.Effect<B, E2, R | R2> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(fork, (fiber) =>
      Effect.onInterrupt(restore(wait(fiber)), () => Fiber.interrupt(fiber)),
    ),
  );
