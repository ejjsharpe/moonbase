import { useRef, useState, type RefObject } from 'react';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { readOwn } from '@moonbase/application/editor';
import { rowHeight, type VisibleRow } from './files-tree-rows.ts';
import type { EditorActions } from '../editor-actions.ts';

/**
 * The files tree as a drop target, for its own entries and for files from the OS alike: the
 * folder a drag would drop into (`dropFolder`, '' for the root), expanding a collapsed folder
 * hovered for a moment, and scrolling near the tree's edges.
 */
export function useDropTarget({
  actions,
  checkout,
  treeElement,
  expanded,
}: {
  actions: EditorActions;
  checkout: CheckoutTarget;
  treeElement: RefObject<HTMLDivElement | null>;
  expanded: ReadonlySet<string>;
}) {
  const [dropFolder, setDropFolder] = useState<string | null>(null),
    hoverExpansion = useRef<{ path: string; timer: number } | null>(null),
    dragLeave = useRef<number | undefined>(undefined);
  /** Expands a folder that a drag has hovered over for a moment. */
  function expandForDrag(path: string) {
    try {
      const current = readOwn(actions.getSnapshot().recovery.views, checkout.checkoutId)?.tree;
      if (!current || current.expanded.includes(path)) return;
      actions.tree(checkout, { expanded: [...current.expanded, path] });
      void actions.list(checkout, path).catch(actions.report);
    } catch (error) {
      actions.report(error);
    }
  }
  /** Drops the highlight and pending expansion; the drag itself may go on elsewhere. */
  function leaveDrag() {
    clearTimeout(hoverExpansion.current?.timer);
    hoverExpansion.current = null;
    clearTimeout(dragLeave.current);
    setDropFolder(null);
  }
  return {
    dropFolder,
    setDropFolder,
    expandForDrag,
    leaveDrag,
    /** Keeps a drag that has moved on to another row from leaving the tree. */
    stayInDrag() {
      clearTimeout(dragLeave.current);
    },
    /** Leaves the drag unless it enters the tree again at once, as moving between rows does. */
    leaveDragSoon() {
      clearTimeout(dragLeave.current);
      dragLeave.current = window.setTimeout(leaveDrag, 50);
    },
    /**
     * Starts, keeps or cancels the pending expansion of the collapsed folder under a drag, other
     * than one of the `dragged` entries or inside one.
     */
    hoverForDrag(row: VisibleRow | undefined, dragged: readonly string[]) {
      const path =
        row?.directory &&
        !expanded.has(row.path) &&
        !dragged.some((path) => row.path === path || row.path.startsWith(path + '/'))
          ? row.path
          : null;
      if (hoverExpansion.current?.path === path) return;
      clearTimeout(hoverExpansion.current?.timer);
      hoverExpansion.current = null;
      if (path === null) return;
      const timer = window.setTimeout(() => {
        hoverExpansion.current = null;
        expandForDrag(path);
      }, 500);
      hoverExpansion.current = { path, timer };
    },
    /** Scrolls while a drag is near the tree's top or bottom edge. */
    scrollForDrag(clientY: number) {
      const element = treeElement.current;
      if (!element) return;
      const { top, bottom } = element.getBoundingClientRect();
      if (clientY < top + rowHeight) element.scrollBy(0, -rowHeight / 2);
      else if (clientY > bottom - rowHeight) element.scrollBy(0, rowHeight / 2);
    },
  };
}

export type DropTarget = ReturnType<typeof useDropTarget>;
