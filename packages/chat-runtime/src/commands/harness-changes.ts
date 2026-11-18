import { Effect, PubSub, Queue, Stream, type Scope } from 'effect';
import { releaseResource } from '../release-resource.ts';
import type { ChatError } from '@moonbase/contracts/chat-errors';
import { watchError } from './safe-error.ts';

/** Subscribes to changes for as long as the watch runs; `changed` asks for another read. */
export type ChangeSources = (changed: () => void) => Effect.Effect<void, ChatError, Scope.Scope>;

/**
 * The one adapter from Pi's change callbacks to a stream: it emits once every source is
 * subscribed, then again after each change a source reports, holding only the latest change while
 * its reader is behind. Sources run their own bookkeeping synchronously in Pi's callback, before
 * any read that could observe the change starts.
 */
export const followChanges = (sources: ChangeSources): Stream.Stream<void, ChatError> =>
  Stream.callback<void, ChatError>(
    (queue) =>
      Effect.andThen(
        sources(() => void Queue.offerUnsafe(queue, undefined)),
        Effect.sync(() => void Queue.offerUnsafe(queue, undefined)),
      ),
    { bufferSize: 1, strategy: 'sliding' },
  );

/** One Pi subscription held by the current scope; one Pi refuses is unavailable (`watchError`). */
export const listenToPi = (
  subscribe: () => () => void,
): Effect.Effect<void, ChatError, Scope.Scope> =>
  Effect.asVoid(
    Effect.acquireRelease(Effect.try({ try: subscribe, catch: watchError }), (off) =>
      releaseResource(off),
    ),
  );

/** Passes each item `pubsub` publishes to `receive` while the current scope is open. */
export const listenToPubSub = <A>(
  pubsub: PubSub.PubSub<A>,
  receive: (item: A) => void,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    // Subscribed now, so nothing published after this returns is missed.
    const subscription = yield* PubSub.subscribe(pubsub);
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.flatMap(PubSub.take(subscription), (item) => Effect.sync(() => receive(item))),
      ),
    );
  });
