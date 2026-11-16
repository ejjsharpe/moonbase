import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type RefObject,
} from 'react';
import * as stylex from '@stylexjs/stylex';
import { filesUI } from '@moonbase/ui/files';
import type { CheckoutTarget, DirectoryListing } from '@moonbase/contracts/workspace';
import {
  checkoutKey,
  type EditorController,
  type MutationAction,
} from '@moonbase/application/editor';
import {
  entriesType,
  findDropFolder,
  getDropDestination,
  isSameDrag,
  listDroppedPaths,
  listTransferred,
  maxDraggedEntries,
  planDrop,
  selectDraggedPaths,
  type MoveRecord,
  type TreeDrag,
} from './files-tree-drop.ts';
import { isListedDirectory, type VisibleRow } from './files-tree-rows.ts';
import { selectEntries } from './move-undo.ts';
import type { DropTarget } from './use-drop-target.ts';
import type { TreeFocus } from './use-tree-focus.ts';
import type { RunMutation } from '../mutation-runner.tsx';

/**
 * The drag a files tree in this document started, until it ends. A tree accepts only its own:
 * DataTransfer contents can't be read until the drop, and a drag from another window or editor
 * is refused.
 */
let activeDrag: TreeDrag | null = null;
/** Whether a files tree in this document is dragging its entries. */
export const isTreeDragActive = () => activeDrag !== null;

/** Shows how many entries are dragged under the pointer instead of the grabbed row alone. */
function setCountImage(dataTransfer: DataTransfer, count: number) {
  const badge = document.createElement('div');
  const { className, style } = stylex.props(filesUI.dragImage);
  if (className) badge.className = className;
  if (style) Object.assign(badge.style, style);
  badge.textContent = String(count);
  document.body.append(badge);
  dataTransfer.setDragImage(badge, -8, -8);
  // The browser captures the image as the drag starts.
  setTimeout(() => badge.remove());
}

/**
 * Dragging a files tree's entries to move them, or copy them with ⌥, into a folder of the same
 * tree. `dragged` are the rows kept mounted while the drag goes on: Chromium stops a drag whose
 * source row unmounts. The handlers ignore drags of anything but the tree's entries.
 */
export function useEntryDrag({
  controller,
  checkout,
  listings,
  selection,
  editing,
  dialogOpen,
  canRequestMutation,
  runMutation,
  onMoved,
  setAnchor,
  mounted,
  focus,
  target,
  findRowAt,
  closeMenu,
}: {
  controller: EditorController;
  checkout: CheckoutTarget;
  listings: Readonly<Record<string, DirectoryListing>>;
  selection: readonly string[];
  /** Whether a name is being typed, which no drag interrupts. */
  editing: boolean;
  dialogOpen: boolean;
  canRequestMutation: (action: MutationAction) => boolean;
  runMutation: RunMutation;
  onMoved: (record: MoveRecord) => void;
  /** Sets the entry a Shift-selection extends from, or clears it. */
  setAnchor: (path: string | null) => void;
  mounted: RefObject<boolean>;
  focus: TreeFocus;
  target: DropTarget;
  /** The listed row an event happened in, or undefined for the tree's empty area. */
  findRowAt: (target: EventTarget | null) => VisibleRow | undefined;
  closeMenu: () => void;
}) {
  const checkoutIdentity = checkoutKey(checkout);
  const [dragged, setDragged] = useState<string[]>([]),
    ownDrag = useRef<TreeDrag | null>(null),
    endDrag = useRef(() => {});
  useLayoutEffect(() => {
    endDrag.current = () => {
      target.leaveDrag();
      if (activeDrag && activeDrag === ownDrag.current) activeDrag = null;
      ownDrag.current = null;
      setDragged((current) => (current.length ? [] : current));
    };
  });
  useEffect(() => {
    if (!dragged.length) return;
    // The browser ends a drag on Escape with dragend; these cover a drag it abandons, or a
    // dragend that never reaches the tree. A press can't happen while a drag goes on, so one
    // means it has ended. Drops bubble here after the tree has taken its own.
    const end = () => endDrag.current();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') end();
    };
    window.addEventListener('blur', end);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('pointerdown', end, true);
    window.addEventListener('dragend', end);
    window.addEventListener('drop', end);
    return () => {
      window.removeEventListener('blur', end);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('pointerdown', end, true);
      window.removeEventListener('dragend', end);
      window.removeEventListener('drop', end);
    };
  }, [dragged.length]);
  useEffect(
    () => () => {
      endDrag.current();
    },
    [],
  );
  /** Where entries dragged over the tree would land, or null when no drop is offered. */
  function planDropInto(folder: string) {
    if (editing || dialogOpen) return null;
    const paths = planDrop(activeDrag, {
      source: controller.instanceId,
      checkout: checkoutIdentity,
      folder,
    });
    return paths && canRequestMutation({ checkout, kind: 'move', paths }) ? paths : null;
  }
  /**
   * Moves or copies dropped entries into `folder`, then expands it and selects them there. A batch
   * that fails partway records and selects the entries it did move.
   */
  async function dropEntries(paths: string[], folder: string, copy: boolean) {
    const directories = new Map(
      paths.map((path) => [path, isListedDirectory(listings, checkoutIdentity, path)]),
    );
    const result = await runMutation(
      { checkout, kind: copy ? 'copy' : 'move', paths },
      getDropDestination(paths, folder),
      { finalFocus: focus.returnTreeFocus },
    );
    const transferred = listTransferred(paths, result);
    if (!transferred.length) return;
    const landed = listDroppedPaths(transferred, folder);
    if (!copy)
      onMoved({
        kind: 'move',
        moves: transferred.map((from, index) => ({
          from,
          to: landed[index],
          directory: directories.get(from)!,
        })),
      });
    if (!mounted.current) return;
    try {
      selectEntries(controller, checkout, landed);
    } catch (error) {
      controller.report(error);
    }
    setAnchor(landed[0]);
    focus.refocusTree();
  }
  const isEntryDrag = (event: DragEvent) => event.dataTransfer.types.includes(entriesType);
  return {
    dragged,
    /** Ends the tree's own drag, whether or not it dropped. */
    endDrag: () => endDrag.current(),
    onDragStart(event: DragEvent) {
      // A drag whose end never arrived is over once another starts.
      endDrag.current();
      const row = findRowAt(event.target);
      if (!row) return;
      const paths = selectDraggedPaths(row.path, selection);
      if (paths.length > maxDraggedEntries) {
        event.preventDefault();
        controller.reportMessage(`Drag at most ${maxDraggedEntries} items at a time.`);
        return;
      }
      if (editing || dialogOpen || !canRequestMutation({ checkout, kind: 'move', paths })) {
        event.preventDefault();
        return;
      }
      const drag = { source: controller.instanceId, checkout: checkoutIdentity, paths };
      event.dataTransfer.setData(entriesType, JSON.stringify(drag));
      // Dropped into the editor or a chat, the drag is its paths as text.
      event.dataTransfer.setData('text/plain', paths.join('\n'));
      event.dataTransfer.effectAllowed = 'copyMove';
      if (paths.length > 1) setCountImage(event.dataTransfer, paths.length);
      activeDrag = ownDrag.current = drag;
      closeMenu();
      // The grabbed row stays mounted even when it moves with a dragged folder.
      setDragged([...new Set([row.path, ...paths])]);
    },
    onDragEnd() {
      endDrag.current();
      focus.releasePress();
    },
    onDragEnter(event: DragEvent) {
      if (!isEntryDrag(event)) return;
      target.stayInDrag();
      // Entering a row that takes the drop must be accepted too, or the browser passes the
      // drag to the page instead.
      if (planDropInto(findDropFolder(findRowAt(event.target)))) event.preventDefault();
    },
    onDragOver(event: DragEvent) {
      // Other drags pass through to the app.
      if (!isEntryDrag(event)) return;
      target.stayInDrag();
      if (
        activeDrag?.source !== controller.instanceId ||
        activeDrag.checkout !== checkoutIdentity
      ) {
        event.dataTransfer.dropEffect = 'none';
        return;
      }
      target.scrollForDrag(event.clientY);
      const row = findRowAt(event.target);
      target.hoverForDrag(row, activeDrag.paths);
      const folder = findDropFolder(row);
      if (!planDropInto(folder)) {
        event.dataTransfer.dropEffect = 'none';
        target.setDropFolder(null);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = event.altKey ? 'copy' : 'move';
      target.setDropFolder(folder);
    },
    onDragLeave(event: DragEvent) {
      // Moving between rows leaves one as it enters the next; only leaving the tree counts.
      if (isEntryDrag(event)) target.leaveDragSoon();
    },
    onDrop(event: DragEvent) {
      if (!isEntryDrag(event)) return;
      event.preventDefault();
      // Only the drag this document started, as the DataTransfer confirms, drops.
      const ours = isSameDrag(event.dataTransfer.getData(entriesType), activeDrag);
      const folder = findDropFolder(findRowAt(event.target)),
        paths = ours ? planDropInto(folder) : null,
        copy = event.altKey;
      endDrag.current();
      if (paths) void dropEntries(paths, folder, copy);
    },
  };
}
