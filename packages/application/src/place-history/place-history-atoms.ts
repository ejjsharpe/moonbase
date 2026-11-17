import * as Atom from 'effect/reactivity/Atom';
import type { PlaceNavigationShape } from './place-history-service.ts';

/** The window's history of places, for the back and forward buttons. */
export const makePlaceHistoryAtoms = (navigation: PlaceNavigationShape) => {
  const history = Atom.subscriptionRef(navigation.state);
  return { history: Atom.readable((get) => get(history)) };
};
