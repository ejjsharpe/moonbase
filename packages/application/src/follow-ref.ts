import type { Stream } from 'effect';
import * as Atom from 'effect/reactivity/Atom';

/** A read-only atom over a `SubscriptionRef`, so views can read a service's state but not set it. */
export const followRef = <A>(ref: Parameters<typeof Atom.subscriptionRef<A>>[0]) => {
  const atom = Atom.subscriptionRef(ref);
  return Atom.readable((get) => get(atom));
};

/**
 * A read-only atom over a stream that replays its current value first, as a `SubscriptionRef`'s
 * changes do, for state a service publishes without its ref. `initial` stands in only until the
 * replay arrives.
 */
export const followChanges = <A>(changes: Stream.Stream<A>, initial: A) => {
  const atom = Atom.make(changes, { initialValue: initial });
  return Atom.readable((get) => {
    const result = get(atom);
    return result._tag === 'Success' ? result.value : initial;
  });
};
