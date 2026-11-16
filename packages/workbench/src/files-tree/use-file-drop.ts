import { useLayoutEffect, useRef, type DragEvent, type RefObject } from 'react';
import { joinPath } from '@moonbase/contracts/paths';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import {
  checkoutKey,
  type EditorController,
  type MutationAction,
} from '@moonbase/application/editor';
import { entriesType, findCollidingName, findDropFolder, takeFileDrop } from './files-tree-drop.ts';
import type { VisibleRow } from './files-tree-rows.ts';
import { selectEntries } from './move-undo.ts';
import type { DropTarget } from './use-drop-target.ts';
import type { TreeFocus } from './use-tree-focus.ts';
import type { RunMutation } from '../mutation-runner.tsx';

/** Whether a drag carries files from the OS, such as Finder's, rather than the tree's entries. */
const isFileDrag = (dataTransfer: DataTransfer) =>
  dataTransfer.types.includes('Files') && !dataTransfer.types.includes(entriesType);

/**
 * Dropping files from the OS, such as Finder's, into a files tree's folder to import them there,
 * once `selectDroppedImports` approves them. Without it, and for other drags, the handlers leave
 * the drag to the app.
 */
export function useFileDrop({
  controller,
  checkout,
  treeElement,
  selectDroppedImports,
  editing,
  dialogOpen,
  canRequestMutation,
  runMutation,
  setAnchor,
  mounted,
  focus,
  target,
  findRowAt,
}: {
  controller: EditorController;
  checkout: CheckoutTarget;
  treeElement: RefObject<HTMLDivElement | null>;
  selectDroppedImports?: (checkout: CheckoutTarget, files: File[]) => Promise<string[]>;
  /** Whether a name is being typed, which refuses imports. */
  editing: boolean;
  dialogOpen: boolean;
  canRequestMutation: (action: MutationAction) => boolean;
  runMutation: RunMutation;
  /** Sets the entry a Shift-selection extends from, or clears it. */
  setAnchor: (path: string | null) => void;
  mounted: RefObject<boolean>;
  focus: TreeFocus;
  target: DropTarget;
  findRowAt: (target: EventTarget | null) => VisibleRow | undefined;
}) {
  const checkoutIdentity = checkoutKey(checkout);
  // What a drop's import, once approved, finds the tree doing now.
  const latest = useRef({ editing, dialogOpen, checkoutIdentity }),
    importingDrop = useRef(false);
  useLayoutEffect(() => {
    latest.current = { editing, dialogOpen, checkoutIdentity };
  });
  /** Whether the tree takes a drag of OS files, importing them when the app can approve them. */
  const takesFiles = (dataTransfer: DataTransfer) =>
    !!selectDroppedImports && isFileDrag(dataTransfer);
  /** Why OS files can't be dropped into the tree now, or '' when they can. */
  function findFileDropProblem() {
    if (importingDrop.current) return 'Wait for the dropped files to import before dropping more.';
    if (editing) return 'Finish naming the entry before importing files.';
    if (dialogOpen)
      return 'Finish the current editor dialog or preservation before importing files.';
    if (!canRequestMutation({ checkout, kind: 'import', paths: [] }))
      return 'Open the exact import checkout before importing files.';
    return '';
  }
  /**
   * Imports files dropped from the OS into `folder`, asking before replacing entries their names
   * land on, then expands the folder and selects what was imported. One drop imports at a time.
   */
  async function importDropped(files: File[], folder: string) {
    const names = files.map((file) => file.name),
      colliding = findCollidingName(names);
    // The workspace would refuse them after the replace prompt; say why before asking anything.
    if (colliding) {
      controller.report(
        `More than one dropped item is named “${colliding}”. Drop them into different folders.`,
      );
      return;
    }
    importingDrop.current = true;
    try {
      await importApproved(files, names, folder);
    } finally {
      importingDrop.current = false;
    }
  }
  async function importApproved(files: File[], names: string[], folder: string) {
    const captured = { ...checkout },
      focusAtDrop = treeElement.current?.ownerDocument.activeElement;
    // Approval can take a while; the tree may have moved on meanwhile. An approval this abandons
    // has no release from here: its references expire unused, or go with the document.
    const references = await selectDroppedImports!(captured, files);
    if (!references.length) return;
    const recovery = controller.getSnapshot().recovery;
    if (
      !mounted.current ||
      latest.current.checkoutIdentity !== checkoutIdentity ||
      !recovery.openCheckoutIds.includes(captured.checkoutId) ||
      !recovery.checkouts.some((target) => checkoutKey(target) === checkoutIdentity)
    ) {
      controller.report('Open the exact import checkout before importing files.');
      return;
    }
    if (latest.current.editing) {
      controller.report('Finish naming the entry before importing files.');
      return;
    }
    if (latest.current.dialogOpen) {
      controller.report('Finish the current editor dialog or preservation before importing files.');
      return;
    }
    // Each reference stands for its file, so the files' names are where they land.
    if (references.length !== names.length) {
      controller.report('Only files and folders can be imported.');
      return;
    }
    const result = await runMutation(
      {
        checkout: captured,
        kind: 'import',
        paths: [],
        nativeReferences: references,
        nativeNames: names,
      },
      references.length > 1 ? folder : joinPath(folder, names[0]),
      { finalFocus: focus.returnTreeFocus },
    );
    const landed = result.items.flatMap((item) =>
      item.outcome === 'completed' && item.destination !== undefined ? [item.destination] : [],
    );
    if (!mounted.current || (!result.completed && !landed.length)) return;
    // A name typed meanwhile keeps its field, and another checkout's tree isn't this import's.
    if (latest.current.editing || latest.current.checkoutIdentity !== checkoutIdentity) return;
    try {
      if (landed.length) selectEntries(controller, captured, landed);
      else if (folder) target.expandForDrag(folder);
    } catch (error) {
      controller.report(error);
    }
    if (landed.length) setAnchor(landed[0]);
    // Focus the user moved elsewhere meanwhile stays there.
    const focused = treeElement.current?.ownerDocument.activeElement;
    if (focused !== focusAtDrop && !focus.focusStayed()) return;
    focus.refocusTree();
  }
  return {
    onDragEnter(event: DragEvent) {
      if (!takesFiles(event.dataTransfer)) return;
      target.stayInDrag();
      // Refused here, the drop is still the tree's, so the app doesn't import it elsewhere.
      event.preventDefault();
    },
    onDragOver(event: DragEvent) {
      if (!takesFiles(event.dataTransfer)) return;
      target.stayInDrag();
      event.preventDefault();
      target.scrollForDrag(event.clientY);
      const row = findRowAt(event.target);
      target.hoverForDrag(row, []);
      const refused = !!findFileDropProblem();
      event.dataTransfer.dropEffect = refused ? 'none' : 'copy';
      target.setDropFolder(refused ? null : findDropFolder(row));
    },
    onDragLeave(event: DragEvent) {
      if (takesFiles(event.dataTransfer)) target.leaveDragSoon();
    },
    onDrop(event: DragEvent) {
      if (!takesFiles(event.dataTransfer)) return;
      // Taken, so the app's window-wide drop doesn't import the files at the root too.
      event.preventDefault();
      takeFileDrop(event.nativeEvent);
      const files = [...event.dataTransfer.files],
        folder = findDropFolder(findRowAt(event.target)),
        problem = findFileDropProblem();
      target.leaveDrag();
      if (!files.length) return;
      if (problem) controller.report(problem);
      else void importDropped(files, folder).catch(controller.report);
    },
  };
}
