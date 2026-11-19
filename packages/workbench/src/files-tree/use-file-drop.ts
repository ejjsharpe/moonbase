import { useEffect, useRef, type DragEvent, type RefObject } from 'react';
import { Effect } from 'effect';
import * as Atom from 'effect/reactivity/Atom';
import { joinPath } from '@moonbase/contracts/paths';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { checkoutKey, type MutationAction } from '@moonbase/application/editor';
import { entriesType, findCollidingName, findDropFolder, takeFileDrop } from './files-tree-drop.ts';
import type { VisibleRow } from './files-tree-rows.ts';
import { selectEntries } from './select-entries.ts';
import type { DropTarget } from './use-drop-target.ts';
import type { TreeFocus } from './use-tree-focus.ts';
import type { RunMutation } from '../mutation-runner.tsx';
import type { EditorActions } from '../editor-actions.ts';
import { useEditorTask } from '../use-editor-task.ts';

/** Whether a drag carries files from the OS, such as Finder's, rather than the tree's entries. */
const isFileDrag = (dataTransfer: DataTransfer) =>
  dataTransfer.types.includes('Files') && !dataTransfer.types.includes(entriesType);

/**
 * Dropping files from the OS, such as Finder's, into a files tree's folder to import them there,
 * once the platform's `selectDroppedImports` approves them. Without it, and for other drags, the
 * handlers leave the drag to the app. Unmounting the tree, as closing its checkout does, abandons
 * a drop still being approved.
 */
export function useFileDrop({
  actions,
  checkout,
  treeElement,
  editing,
  dialogOpen,
  canRequestMutation,
  runMutation,
  setAnchor,
  focus,
  target,
  findRowAt,
}: {
  actions: EditorActions;
  checkout: CheckoutTarget;
  treeElement: RefObject<HTMLDivElement | null>;
  /** Whether a name is being typed, which refuses imports. */
  editing: boolean;
  dialogOpen: boolean;
  canRequestMutation: (action: MutationAction) => boolean;
  runMutation: RunMutation;
  /** Sets the entry a Shift-selection extends from, or clears it. */
  setAnchor: (path: string | null) => void;
  focus: TreeFocus;
  target: DropTarget;
  findRowAt: (target: EventTarget | null) => VisibleRow | undefined;
}) {
  const checkoutIdentity = checkoutKey(checkout);
  const { selectDroppedImports } = actions.platform;
  // One drop imports at a time, from approval until its entries are selected.
  const run = useEditorTask(actions, { replace: true });
  const phase = useRef<'idle' | 'approving' | 'importing'>('idle');
  const shownCheckout = useRef(checkoutIdentity);
  // The tree moving on interrupts a drop: typing a name, opening a dialog or showing another
  // checkout while it is approved refuses it; a name typed while it imports keeps its field,
  // since the import itself runs on as the editor's.
  useEffect(() => {
    const moved = shownCheckout.current !== checkoutIdentity;
    shownCheckout.current = checkoutIdentity;
    const approving = phase.current === 'approving';
    if (phase.current === 'idle' || !(editing || moved || (approving && dialogOpen))) return;
    phase.current = 'idle';
    run(Atom.Interrupt);
    if (!approving) return;
    if (moved) actions.report('Open the exact import checkout before importing files.');
    else if (editing) actions.report('Finish naming the entry before importing files.');
    else actions.report('Finish the current editor dialog or preservation before importing files.');
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- what the tree is doing now.
  }, [editing, dialogOpen, checkoutIdentity]);
  /** Whether the tree takes a drag of OS files, importing them when the app can approve them. */
  const takesFiles = (dataTransfer: DataTransfer) =>
    !!selectDroppedImports && isFileDrag(dataTransfer);
  /** Why OS files can't be dropped into the tree now, or '' when they can. */
  function findFileDropProblem() {
    if (phase.current !== 'idle')
      return 'Wait for the dropped files to import before dropping more.';
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
  function importDropped(files: File[], folder: string) {
    const names = files.map((file) => file.name),
      colliding = findCollidingName(names);
    // The workspace would refuse them after the replace prompt; say why before asking anything.
    if (colliding) {
      actions.report(
        `More than one dropped item is named “${colliding}”. Drop them into different folders.`,
      );
      return;
    }
    phase.current = 'approving';
    run(
      importApproved(files, names, folder).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            phase.current = 'idle';
          }),
        ),
      ),
    );
  }
  const importApproved = (files: File[], names: string[], folder: string) =>
    Effect.gen(function* () {
      const captured = { ...checkout },
        focusAtDrop = treeElement.current?.ownerDocument.activeElement;
      // Approval can take a while; the tree may have moved on meanwhile. An approval this abandons
      // has no release from here: its references expire unused, or go with the document.
      const references = yield* selectDroppedImports!(captured, files);
      if (!references.length) return;
      const recovery = actions.getSnapshot().recovery;
      if (
        !recovery.openCheckoutIds.includes(captured.checkoutId) ||
        !recovery.checkouts.some((target) => checkoutKey(target) === checkoutIdentity)
      ) {
        actions.report('Open the exact import checkout before importing files.');
        return;
      }
      // Each reference stands for its file, so the files' names are where they land.
      if (references.length !== names.length) {
        actions.report('Only files and folders can be imported.');
        return;
      }
      phase.current = 'importing';
      const result = yield* runMutation(
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
      if (!result.completed && !landed.length) return;
      if (landed.length) selectEntries(actions, captured, landed);
      else if (folder) target.expandForDrag(folder);
      if (landed.length) setAnchor(landed[0]);
      // Focus the user moved elsewhere meanwhile stays there.
      const focused = treeElement.current?.ownerDocument.activeElement;
      if (focused !== focusAtDrop && !focus.focusStayed()) return;
      focus.refocusTree();
    });
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
      if (problem) actions.report(problem);
      else importDropped(files, folder);
    },
  };
}
