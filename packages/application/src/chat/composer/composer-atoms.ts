import * as Atom from 'effect/reactivity/Atom';
import type { ChatComposer } from './composer-service.ts';

/** Each chat composer's state, for views to subscribe to. */
export const composerAtoms = {
  state: Atom.family((composer: ChatComposer) => {
    const atom = Atom.subscriptionRef(composer.state);
    return Atom.readable((get) => get(atom));
  }),
};
