import { type Array as Arr, Duration, Effect, Option, Queue, Schedule, Sink, Stream } from 'effect';

/** A watch reports at most one batch this often. */
const observationInterval = Duration.millis(100);
/** The most changes a watch holds while nothing pulls its feed. */
const changeCapacity = 4096;

/** What one native watcher reported: a changed path (unnamed when it could not say), or a failure. */
export type Change = { readonly path: string | undefined } | { readonly error: string };

/**
 * The changes of one 100 ms window. `paths` is undefined once a change could not name its path.
 * The fold owns `paths` and adds to it in place: a batch is not shared until its window closes.
 */
export type Batch = { paths: Set<string> | undefined; readonly error: string | undefined };

/** Folds a change into its window; the latest failure wins. */
const addChange = (batch: Batch, change: Change): Batch => {
  if ('error' in change) return { paths: undefined, error: change.error };
  if (change.path === undefined) batch.paths = undefined;
  else batch.paths?.add(change.path);
  return batch;
};

/**
 * The bounded feed of one watch's native changes, coalesced into windows. A window opens with its
 * first change (a checkout writes many files) and gathers the rest for 100 ms; changes meanwhile
 * wait for the next one. A change that does not fit is dropped and the next batch is unnamed, so
 * a dropped path can never let that batch be skipped.
 */
export const makeChangeFeed = Effect.fnUntraced(function* (capacity: number = changeCapacity) {
  const changes = yield* Queue.dropping<Change>(capacity);
  // What a full queue dropped: that a path was lost, and the latest failure, which must reach the
  // client because its watcher has stopped.
  const overflowed = yield* Queue.sliding<void>(1);
  const failed = yield* Queue.sliding<string>(1);
  return {
    /** Records a change; safe to call from a native callback. */
    offer: (change: Change) => {
      if (Queue.offerUnsafe(changes, change)) return;
      if ('error' in change) Queue.offerUnsafe(failed, change.error);
      else Queue.offerUnsafe(overflowed, undefined);
    },
    /** Ends `batches`. */
    shutdown: Effect.all([
      Queue.shutdown(changes),
      Queue.shutdown(overflowed),
      Queue.shutdown(failed),
    ]),
    // Every chunk polls what was dropped as it is taken, so the batch emitted after a drop is
    // unnamed and carries a dropped failure. A drop always leaves the queue full, so a later chunk
    // always follows it.
    batches: Stream.fromQueue(changes).pipe(
      Stream.mapArrayEffect((taken) =>
        Effect.map(
          Effect.all([Queue.poll(overflowed), Queue.poll(failed)]),
          ([dropped, failure]): Arr.NonEmptyReadonlyArray<Change> => [
            ...taken,
            ...(Option.isSome(dropped) ? [{ path: undefined }] : []),
            ...(Option.isSome(failure) ? [{ error: failure.value }] : []),
          ],
        ),
      ),
      Stream.aggregateWithin(
        Sink.reduce((): Batch => ({ paths: new Set(), error: undefined }), addChange),
        Schedule.spaced(observationInterval),
      ),
    ),
  };
});
