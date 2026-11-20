import { useContext, useMemo } from 'react';
import { RegistryContext, useAtom, useAtomSet } from '@effect/atom-react';
import * as Atom from 'effect/reactivity/Atom';
import type { EditorActions } from './editor-actions.ts';
import { makeWorkAtom, type WorkbenchWork } from './workbench-editor.ts';

/** One view's function atom, removed as soon as the view stops reading it. */
const useTaskAtom = (actions: EditorActions, concurrent: boolean) => {
  const { runtime } = actions.editor;
  return useMemo(
    () => Atom.setIdleTTL(makeWorkAtom(runtime, concurrent), 0),
    [runtime, concurrent],
  );
};

/**
 * Runs Effects for one view through an atom function on the editor's runtime, reporting their
 * failures. Unmounting the view interrupts what it started; with `replace`, starting one also
 * interrupts the one running, as a newer open replaces an older one. Work the editor owns, such
 * as a save or a file operation, runs on even when its caller is interrupted.
 */
export function useEditorTask(actions: EditorActions, { replace = false } = {}) {
  return useAtomSet(useTaskAtom(actions, !replace));
}

/**
 * `useEditorTask` for a view that runs one task at a time and shows while it runs: starting
 * another meanwhile does nothing.
 */
export function usePendingEditorTask(actions: EditorActions) {
  const registry = useContext(RegistryContext);
  const atom = useTaskAtom(actions, false);
  const [result, start] = useAtom(atom);
  const run = (work: WorkbenchWork) => {
    if (!registry.get(atom).waiting) start(work);
  };
  return [result.waiting, run] as const;
}
