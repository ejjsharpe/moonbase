import * as Atom from 'effect/reactivity/Atom';

/** A read-only atom over a `SubscriptionRef`, so views can read a service's state but not set it. */
export const followRef = <A>(ref: Parameters<typeof Atom.subscriptionRef<A>>[0]) => {
  const atom = Atom.subscriptionRef(ref);
  return Atom.readable((get) => get(atom));
};
