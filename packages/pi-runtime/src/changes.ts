import { Cause, Effect, Queue, Stream } from 'effect';
import type { ApplicationError } from '@moonbase/contracts/workspace';
import { normalizeApplicationError } from '@moonbase/effect';

/**
 * Passes `read()`'s value to `receive` at once, then again after each change `subscribe`
 * reports, until the returned function stops it. One read runs at a time; changes during it start
 * one more. A failed read is passed to `fail`, and later changes read again.
 */
export function followChanges<A>(
  subscribe: (listener: () => void) => () => void,
  read: () => Promise<A>,
  receive: (value: A) => void,
  fail: (error: unknown) => void,
): () => void {
  let reading = false,
    again = false,
    stopped = false;
  const run = async () => {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    try {
      do {
        again = false;
        const value = await read();
        if (stopped) return;
        receive(value);
      } while (again && !stopped);
    } catch (error) {
      if (!stopped) fail(error);
    } finally {
      reading = false;
    }
  };
  const off = subscribe(() => void run());
  void run();
  return () => {
    stopped = true;
    off();
  };
}

/** `followChanges` as a stream whose consumer, when behind, holds only the latest value. */
export function readOnChange<A>(
  subscribe: (listener: () => void) => () => void,
  read: () => Promise<A>,
): Stream.Stream<A, ApplicationError> {
  return Stream.callback<A, ApplicationError>(
    (queue) =>
      Effect.asVoid(
        Effect.acquireRelease(
          Effect.sync(() =>
            followChanges(
              subscribe,
              read,
              (value) => void Queue.offerUnsafe(queue, value),
              (error) =>
                void Queue.failCauseUnsafe(queue, Cause.fail(normalizeApplicationError(error))),
            ),
          ),
          (stop) => Effect.sync(stop),
        ),
      ),
    { bufferSize: 1, strategy: 'sliding' },
  );
}
