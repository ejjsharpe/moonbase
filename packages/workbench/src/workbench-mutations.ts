import { useContext, useMemo } from 'react';
import { RegistryContext, useAtomValue } from '@effect/atom-react';
import * as Atom from 'effect/reactivity/Atom';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import {
  checkoutKey,
  mutationUnavailable,
  type EditorSnapshot,
  type MutationAction,
} from '@moonbase/application/editor';
import { useFileClipboard } from './files-tree/use-file-clipboard.ts';
import { useMoveUndo } from './files-tree/use-move-undo.ts';
import { useMutationRunner } from './mutation-runner.tsx';
import type { EditorActions } from './editor-actions.ts';

/** A file operation's dialog, Move to Trash or Import, and where it returns focus as it closes. */
export type MutationDialog = {
  action: MutationAction;
  finalFocus?: () => boolean | HTMLElement | null;
};

/**
 * A workbench's file operations behind the one mutation gate: none of the workbench's own dialogs
 * open (`pickerOpen`, or a file operation's dialog), then the editor's. The tree runs Rename,
 * Duplicate, New File/Folder, moves and pastes directly, asking only to replace; Move to Trash and
 * Import open their dialog.
 */
export function useWorkbenchMutations({
  actions,
  state,
  openCheckouts,
  pickerOpen,
  copyPaths,
}: {
  actions: EditorActions;
  state: EditorSnapshot;
  openCheckouts: readonly CheckoutTarget[];
  pickerOpen: boolean;
  copyPaths?: (checkout: CheckoutTarget, paths: string[], relative: boolean) => Promise<void>;
}) {
  // The open dialog, read at once by a second request in the same tick (two `importFiles` calls,
  // say), ahead of the render that shows the first.
  const registry = useContext(RegistryContext);
  const dialogAtom = useMemo(() => Atom.make<MutationDialog | null>(null), []);
  const dialog = useAtomValue(dialogAtom);
  const setDialog = (next: MutationDialog | null) => registry.set(dialogAtom, next);
  const isDialogOpen = () => !!registry.get(dialogAtom) || pickerOpen;
  /** The mutation gate. */
  const canRequestMutation = (action: MutationAction) =>
    !isDialogOpen() && actions.admitsMutation(action);
  // Applies the workbench's part of the gate and leaves the rest to the editor's gate.
  const runner = useMutationRunner(actions, state, isDialogOpen);
  // Moves and renames made from the tree, one per checkout, for Undo; any other file operation
  // from the tree or a dialog forgets the checkout's.
  const moveUndo = useMoveUndo(actions, runner.runMutation, openCheckouts);
  // Entries cut or copied in the tree, until pasted; copies forget the move to undo.
  const fileClipboard = useFileClipboard({
    actions,
    runMutation: moveUndo.run,
    recordMove: moveUndo.record,
    canRequestMutation,
    copyPaths,
  });
  /** Opens a file operation's dialog, Move to Trash, if the gate admits it. */
  function requestMutation(action: MutationAction, finalFocus?: MutationDialog['finalFocus']) {
    if (!canRequestMutation(action)) {
      actions.report(mutationUnavailable);
      return;
    }
    setDialog({
      action: { ...action, checkout: { ...action.checkout }, paths: [...action.paths] },
      finalFocus,
    });
  }
  /** Opens the Import dialog for approved file references, into an open checkout. */
  function importFiles(checkout: CheckoutTarget, references: string[]) {
    if (!references.length) return;
    const snapshot = actions.getSnapshot();
    if (snapshot.holdingUnsaved || isDialogOpen() || snapshot.closePrompt) {
      actions.report('Finish the current editor dialog or Close prompt before importing files.');
      return;
    }
    if (
      !snapshot.recovery.openCheckoutIds.includes(checkout.checkoutId) ||
      !snapshot.recovery.checkouts.some((item) => checkoutKey(item) === checkoutKey(checkout))
    ) {
      actions.report('Open the exact import checkout before importing files.');
      return;
    }
    setDialog({
      action: {
        checkout: { ...checkout },
        kind: 'import',
        paths: [],
        nativeReferences: [...references],
      },
    });
  }
  return {
    dialog,
    closeDialog: () => setDialog(null),
    /** Whether one of the workbench's own dialogs is open. */
    dialogOpen: !!dialog || pickerOpen,
    canRequestMutation,
    requestMutation,
    importFiles,
    /** The running mutation's replace prompt. */
    confirmation: runner.confirmation,
    moveUndo,
    fileClipboard,
  };
}
