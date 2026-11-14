import { Cause, Effect, Queue, Stream } from 'effect';
import type { ObservationClose } from '@moonbase/contracts/common';
import type { ApplicationError } from '@moonbase/contracts/errors';

/**
 * A callback watch as a stream: its values until it fails, closed when the stream ends. A failure
 * the watch delivered is its outcome, not a failure to close it; another close failure has no
 * request left to answer with, so it goes to `reportCleanup`.
 */
export const streamObservation = <A>(
  watch: (receive: (value: A) => void, fail: (error: ApplicationError) => void) => ObservationClose,
  reportCleanup: (error: unknown) => void,
): Stream.Stream<A, ApplicationError> =>
  Stream.callback<A, ApplicationError>((queue) => {
    let failed = false;
    return Effect.acquireRelease(
      Effect.sync(() =>
        watch(
          (value) => void Queue.offerUnsafe(queue, value),
          (error) => {
            failed = true;
            Queue.failCauseUnsafe(queue, Cause.fail(error));
          },
        ),
      ),
      (close) =>
        Effect.promise(() =>
          close().catch((error: unknown) => {
            if (!failed) reportCleanup(error);
          }),
        ),
    );
  });
