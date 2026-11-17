import { Cause, Effect, Exit, Stream, type ManagedRuntime } from 'effect';

// Legacy (epic #273 D16): the chat's Promise clients and controller run their Effects through
// these until CL-22 #295 moves chat to services and atoms.

/** The root runtime's runner, the one the chat runs its Effects on. */
export type ChatRunner = Pick<ManagedRuntime.ManagedRuntime<never, unknown>, 'runPromiseExit'>;
import { ApplicationError } from '@moonbase/contracts/errors';
import type { CommandOptions, ObservationClose } from '@moonbase/contracts/common';
import { normalizeApplicationError, toApplicationError } from '@moonbase/effect';

export async function runApplicationEffect<A, R, E>(
  runtime: Pick<ManagedRuntime.ManagedRuntime<R, E>, 'runPromiseExit'>,
  effect: Effect.Effect<A, ApplicationError, R>,
  options?: CommandOptions,
): Promise<A> {
  if (options?.signal?.aborted)
    throw new ApplicationError({ code: 'Cancelled', message: 'Command cancelled' });
  let exit;
  try {
    exit = await runtime.runPromiseExit(effect, options);
  } catch (error) {
    throw normalizeApplicationError(error);
  }
  if (Exit.isFailure(exit)) throw toApplicationError(exit.cause);
  return exit.value;
}

/** Close fences delivery immediately and joins the actual stream finalizers. */
export function observeApplicationStream<A, R, E>(
  runtime: Pick<ManagedRuntime.ManagedRuntime<R, E>, 'runPromiseExit'>,
  stream: Stream.Stream<A, ApplicationError, R>,
  receive: (event: A) => void,
  onError: (error: ApplicationError) => void,
): ObservationClose {
  const abort = new AbortController();
  let closing = false;
  let closed: Promise<void> | undefined;
  // Store the outcome as a value so active failure delivery cannot create an unhandled rejection.
  const completion = Promise.resolve()
    .then(() =>
      runtime.runPromiseExit(
        Stream.runForEach(stream, (event) =>
          Effect.sync(() => {
            if (!closing) receive(event);
          }),
        ),
        { signal: abort.signal },
      ),
    )
    .then(
      (exit) =>
        Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
          ? toApplicationError(exit.cause)
          : undefined,
      normalizeApplicationError,
    )
    .then((error) => {
      if (error && !closing) {
        try {
          onError(error);
        } catch {
          /* The owned close outcome remains available to the caller. */
        }
      }
      return error;
    });
  return () => {
    if (!closed) {
      closing = true;
      abort.abort();
      closed = completion.then((error) => {
        if (error) throw error;
      });
    }
    return closed;
  };
}
