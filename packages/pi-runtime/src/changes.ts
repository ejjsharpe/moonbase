import { Cause, Effect, Queue, Stream } from 'effect';
import type { ApplicationError } from '@moonbase/contracts/workspace';
import { normalizeApplicationError } from '@moonbase/effect';

/**
 * `read()`'s value at once, then again after each change `subscribe` reports. One read runs at a
 * time; changes during it start one more, and a consumer behind holds only the latest value.
 */
export function readOnChange<A>(
  subscribe: (listener: () => void) => () => void,
  read: () => Promise<A>,
): Stream.Stream<A, ApplicationError> {
  return Stream.callback<A, ApplicationError>(
    (queue) =>
      Effect.gen(function* () {
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
              Queue.offerUnsafe(queue, value);
            } while (again && !stopped);
          } catch (error) {
            if (!stopped)
              Queue.failCauseUnsafe(queue, Cause.fail(normalizeApplicationError(error)));
          } finally {
            reading = false;
          }
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => subscribe(() => void run())),
          (off) =>
            Effect.sync(() => {
              stopped = true;
              off();
            }),
        );
        void run();
      }),
    { bufferSize: 1, strategy: 'sliding' },
  );
}
