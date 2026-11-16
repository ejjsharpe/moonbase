import * as Atom from 'effect/reactivity/Atom';
import type { EditorLookupShape, Lookup } from './lookup-service.ts';

/** A popup's lookup, alive while mounted, and the state of a lookup. */
export const makeLookupAtoms = (service: EditorLookupShape) => ({
  /** A lookup for as long as the atom is mounted. */
  lookup: Atom.make(service.make),
  state: Atom.family((lookup: Lookup) => {
    const atom = Atom.subscriptionRef(lookup.state);
    return Atom.readable((get) => get(atom));
  }),
});
