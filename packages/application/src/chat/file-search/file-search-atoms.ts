import * as Atom from 'effect/reactivity/Atom';
import type { ChatFileSearchShape, FileSearch } from './file-search-service.ts';

/** A composer's file picker, alive while mounted, and what a picker shows. */
export const makeFileSearchAtoms = (service: ChatFileSearchShape) => ({
  /** A file picker for as long as the atom is mounted. */
  search: Atom.make(service.make),
  state: Atom.family((search: FileSearch) => {
    const atom = Atom.subscriptionRef(search.state);
    return Atom.readable((get) => get(atom));
  }),
});
