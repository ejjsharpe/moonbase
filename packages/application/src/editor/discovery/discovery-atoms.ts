import * as Atom from 'effect/reactivity/Atom';
import { Equal } from 'effect';
import type { Comparison, GitStatus } from '@moonbase/contracts/workspace';
import { followRef } from '../../follow-ref.ts';
import type { EditorDiscoveryShape } from './discovery-service.ts';
import { pickCheckoutListings } from './discovery.ts';

/** What the editor has read of its checkouts, one checkout or file at a time. */
export function makeDiscoveryAtoms(discovery: EditorDiscoveryShape) {
  const state = followRef(discovery.state);
  return {
    state,
    /** A checkout's listings by `listingKey`, by its checkout key. */
    listings: Atom.family((checkout: string) =>
      Atom.readable((get) => pickCheckoutListings(get(state).listings, checkout)).pipe(
        Atom.withEquality(Equal.equals),
      ),
    ),
    /** A checkout's Git status, by its checkout key. */
    git: Atom.family((checkout: string) =>
      Atom.readable((get): GitStatus | undefined => get(state).git[checkout]),
    ),
    /** A file's comparison, by its file key. */
    comparison: Atom.family((key: string) =>
      Atom.readable((get): Comparison | undefined => get(state).comparisons[key]),
    ),
  };
}
