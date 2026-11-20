import * as Atom from 'effect/reactivity/Atom';
import { followRef } from '../../follow-ref.ts';
import type { EditorSessionShape } from './session-service.ts';

/** The editor's modes, whole and one at a time, so a view re-renders only for the one it reads. */
export function makeSessionAtoms(session: EditorSessionShape) {
  const state = followRef(session.state);
  return {
    state,
    /** Recovery has loaded. */
    ready: Atom.readable((get) => get(state).ready),
    /** The editor has released everything it owned. */
    disposed: Atom.readable((get) => get(state).disposed),
    /** A close or reload holds the editor until its prompt is answered. */
    preserving: Atom.readable((get) => get(state).preserving),
    /** The checkout whose `initializeRepository` is running. */
    initializing: Atom.readable((get) => get(state).initializing),
  };
}
