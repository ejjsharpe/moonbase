import { useRef, useState } from 'react';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import {
  checkoutKey,
  mutationUnavailable,
  type EditorController,
  type EditorSnapshot,
  type MutationAction,
} from '@moonbase/application/editor';
import { useFileClipboard } from './files-tree/file-clipboard.ts';
import { useMoveUndo } from './files-tree/move-undo.ts';
import { useMutationRunner } from './mutation-runner.tsx';

/** A file operation's dialog, Move to Trash or Import, and where it returns focus as it closes. */
export type MutationDialog = {
  action: MutationAction;
  finalFocus?: () => boolean | HTMLElement | null;
};

/**
 * A workbench's file operations behind the one mutation gate: none of the workbench's own dialogs
 * open (`pickerOpen`, or a file operation's dialog), then the controller's. The tree runs Rename,
 * Duplicate, New File/Folder, moves and pastes directly, asking only to replace; Move to Trash and
 * Import open their dialog.
 */
export function useWorkbenchMutations({
  controller,
  state,
  openCheckouts,
  pickerOpen,
  copyPaths,
}: {
  controller: EditorController;
  state: EditorSnapshot;
  openCheckouts: readonly CheckoutTarget[];
  pickerOpen: boolean;
  copyPaths?: (checkout: CheckoutTarget, paths: string[], relative: boolean) => Promise<void>;
}) {
  const [dialog, showDialog] = useState<MutationDialog | null>(null);
  // The dialog as last opened or closed, ahead of the render that shows it, so a second request
  // in the same tick (two `importFiles` calls, say) finds the first dialog open.
  const opened = useRef<MutationDialog | null>(null);
  function setDialog(next: MutationDialog | null) {
    opened.current = next;
    showDialog(next);
  }
  const isDialogOpen = () => !!opened.current || pickerOpen;
  /** The mutation gate. */
  const canRequestMutation = (action: MutationAction) =>
    !isDialogOpen() && controller.mutations.admits(action);
  // Applies the workbench's part of the gate and leaves the rest to the controller's run.
  const runner = useMutationRunner(controller, state, isDialogOpen);
  // Moves and renames made from the tree, one per checkout, for Undo; any other file operation
  // from the tree or a dialog forgets the checkout's.
  const moveUndo = useMoveUndo(controller, runner.runMutation, openCheckouts);
  // Entries cut or copied in the tree, until pasted; copies forget the move to undo.
  const fileClipboard = useFileClipboard({
    controller,
    runMutation: moveUndo.run,
    recordMove: moveUndo.record,
    canRequestMutation,
    copyPaths,
  });
  /** Opens a file operation's dialog, Move to Trash, if the gate admits it. */
  function requestMutation(action: MutationAction, finalFocus?: MutationDialog['finalFocus']) {
    if (!canRequestMutation(action)) {
      controller.reportMessage(mutationUnavailable);
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
    const snapshot = controller.getSnapshot();
    if (snapshot.preserving || isDialogOpen() || snapshot.closePrompt) {
      controller.reportMessage(
        'Finish the current editor dialog or preservation before importing files.',
      );
      return;
    }
    if (
      !snapshot.recovery.openCheckoutIds.includes(checkout.checkoutId) ||
      !snapshot.recovery.checkouts.some((item) => checkoutKey(item) === checkoutKey(checkout))
    ) {
      controller.reportMessage('Open the exact import checkout before importing files.');
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
