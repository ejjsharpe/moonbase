import { Cause, Deferred, Effect, Exit, Fiber } from 'effect';

// A transcript forks each read waiting at a gate and opens it once it has published that the read
// started, so whatever that publication prompts (a cancel, a newer read) can stop the read before
// it does anything.

/** `work`, once `gate` opens. */
export const behindGate = (gate: Deferred.Deferred<void>, work: Effect.Effect<void>) =>
  Effect.andThen(Deferred.await(gate), work);

/** Runs `admit`, then opens `gate` however it ended. */
export const admitThrough = (gate: Deferred.Deferred<void>, admit: Effect.Effect<void>) =>
  Effect.ensuring(admit, Deferred.succeed(gate, undefined));

/**
 * Waits for a read fiber to end. Its failures were published and its interruption is a
 * cancellation, so only a defect (such as one thrown while publishing) fails the wait.
 */
export const joinRead = (fiber: Fiber.Fiber<void>): Effect.Effect<void> =>
  Effect.flatMap(Fiber.await(fiber), (exit) =>
    Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
      ? Effect.failCause(exit.cause)
      : Effect.void,
  );
