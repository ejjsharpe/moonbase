import * as Atom from 'effect/reactivity/Atom';
import { makeNativeActions, type NativeActions } from './native-actions-runner.ts';

/** A transcript's native actions, alive while its view is mounted, and their notice. */
export const nativeActionsAtoms = {
  /** One transcript's actions, by a key unique to its view. */
  actions: Atom.family((_view: string) => Atom.make(makeNativeActions)),
  notice: Atom.family((actions: NativeActions) => {
    const atom = Atom.subscriptionRef(actions.notice);
    return Atom.readable((get) => get(atom));
  }),
};
