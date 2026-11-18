import * as Atom from 'effect/reactivity/Atom';
import type { ChatFileSearchShape, FileSearch } from './file-search-service.ts';

/** A composer's file picker, alive while its view is mounted, and what a picker shows. */
export const makeFileSearchAtoms = (service: ChatFileSearchShape) => ({
  /** One composer's file picker, by a key unique to its view; unmounting it cancels its search. */
  search: Atom.family((_view: string) => Atom.make(service.make)),
  state: Atom.family((search: FileSearch) => {
    const atom = Atom.subscriptionRef(search.state);
    return Atom.readable((get) => get(atom));
  }),
});
