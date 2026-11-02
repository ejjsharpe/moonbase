import { Cause, Effect, Exit, Stream, type ManagedRuntime } from 'effect';
import {
  ApplicationError,
  type CommandOptions,
  type ObservationClose,
} from '@moonbase/contracts/workspace';
import { normalizeApplicationError } from '@moonbase/effect';
export { normalizeApplicationError } from '@moonbase/effect';

function applicationFailure(cause: Cause.Cause<ApplicationError>): ApplicationError {
  if (Cause.hasInterruptsOnly(cause))
    return new ApplicationError({ code: 'Cancelled', message: 'Command cancelled' });
  const failures = cause.reasons.flatMap((reason) => {
    if (Cause.isFailReason(reason)) return [reason.error];
    if (Cause.isDieReason(reason)) return [reason.defect];
    return [];
  });
  if (failures.length === 1 && ApplicationError.is(failures[0])) return failures[0];
  const typed = failures.find(ApplicationError.is);
  return new ApplicationError({
    code: typed?.code ?? 'Unavailable',
    target: typed?.target,
    message:
      failures.map((value) => normalizeApplicationError(value).message).join('; ') ||
      'Application effect failed',
  });
}

export async function runApplicationEffect<A, R, E extends ApplicationError>(
  runtime: ManagedRuntime.ManagedRuntime<R, E>,
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
  if (Exit.isFailure(exit)) throw applicationFailure(exit.cause);
  return exit.value;
}

/** Close fences delivery immediately and joins the actual stream finalizers. */
export function observeApplicationStream<A, R, E extends ApplicationError>(
  runtime: ManagedRuntime.ManagedRuntime<R, E>,
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
          ? applicationFailure(exit.cause)
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
