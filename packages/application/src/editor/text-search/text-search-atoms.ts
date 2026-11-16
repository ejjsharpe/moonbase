import * as Atom from 'effect/reactivity/Atom';
import type { EditorTextSearchShape, TextSearch } from './text-search-service.ts';

/** A popup's search, alive while mounted, and the state of a search. */
export const makeTextSearchAtoms = (service: EditorTextSearchShape) => ({
  /** A search for as long as the atom is mounted. */
  search: Atom.make(service.make),
  state: Atom.family((search: TextSearch) => {
    const atom = Atom.subscriptionRef(search.state);
    return Atom.readable((get) => get(atom));
  }),
});
