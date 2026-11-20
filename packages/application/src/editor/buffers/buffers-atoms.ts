import { Equal } from 'effect';
import * as Atom from 'effect/reactivity/Atom';
import { followRef } from '../../follow-ref.ts';
import type { EditorBuffersShape } from './buffers-service.ts';
import { listDirtyPaths, toBufferStatus } from './buffers.ts';

/**
 * The open buffers, and what a view shows of each one by its file's key. Typing changes a buffer's
 * text, which only `state` and the Monaco models follow: the atoms below change with its status.
 */
export function makeBuffersAtoms(buffers: EditorBuffersShape) {
  const state = followRef(buffers.state);
  return {
    state,
    /** A file's buffer as a tab or notice shows it, or undefined while it has none. */
    status: Atom.family((key: string) =>
      Atom.readable((get) => {
        const buffer = get(state).buffers.get(key);
        return buffer && toBufferStatus(buffer);
      }).pipe(Atom.withEquality(Equal.equals)),
    ),
    /** The paths of a checkout's buffers with edits not on disk, by its checkout key. */
    dirtyPaths: Atom.family((checkout: string) =>
      Atom.readable((get) => listDirtyPaths(get(state), checkout)).pipe(
        Atom.withEquality(Equal.equals),
      ),
    ),
  };
}
