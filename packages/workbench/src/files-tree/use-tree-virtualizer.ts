import { useEffect, useRef, type RefObject } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { addPinnedIndexes, overscan, rowHeight, type VisibleRow } from './files-tree-rows.ts';

/**
 * Mounts the files tree's rows in or near its scrolled window, at a fixed height each, and keeps
 * the focused row and each new edit in view. The focused row and `pinnedPaths` stay mounted
 * wherever they are: Chromium stops a drag whose source row unmounts. The tree starts at
 * `initialScroll`, and tells `onScrollRest` where it comes to rest after scrolling, or where it
 * was if it unmounts first.
 */
export function useTreeVirtualizer({
  treeElement,
  rows,
  focus,
  editPath,
  editId,
  pinnedPaths,
  initialScroll,
  onScrollRest,
}: {
  treeElement: RefObject<HTMLDivElement | null>;
  /** The rows as shown, placeholder included. */
  rows: readonly VisibleRow[];
  focus: string;
  /** The row whose name is typed, if any, and that edit's id. */
  editPath: string | null;
  editId: number | undefined;
  pinnedPaths: readonly string[];
  initialScroll: number;
  onScrollRest: (scroll: number) => void;
}) {
  // Whether the tree has scrolled since it last came to rest, and where to.
  const scrolled = useRef<number | null>(null);
  const focusIndex = Math.max(
      0,
      rows.findIndex((row) => row.path === focus),
    ),
    editIndex = editPath === null ? -1 : rows.findIndex((row) => row.path === editPath);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => treeElement.current,
    estimateSize: () => rowHeight,
    overscan,
    // The virtualizer starts where the tree was left, so keeping focus in view leaves a row that
    // is already shown where it is.
    initialOffset: initialScroll,
    // Saving each scroll would publish the recovery and render the workbench for each.
    onChange(instance) {
      const offset = instance.scrollOffset ?? 0;
      if (instance.isScrolling) scrolled.current = offset;
      else if (scrolled.current !== null) {
        scrolled.current = null;
        onScrollRest(offset);
      }
    },
    rangeExtractor: (range) =>
      addPinnedIndexes(
        defaultRangeExtractor(range),
        rows,
        focusIndex,
        editPath === null ? pinnedPaths : [editPath, ...pinnedPaths],
      ),
  });
  useEffect(() => {
    return () => {
      if (scrolled.current === null) return;
      try {
        onScrollRest(scrolled.current);
      } catch {
        // The checkout or the editor has gone, and its scroll with it.
      }
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Save a scroll still moving as the tree unmounts.
  }, []);
  function scrollToRow(index: number) {
    if (index >= 0 && index < rows.length) virtualizer.scrollToIndex(index);
  }
  useEffect(() => {
    scrollToRow(focusIndex);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Follow focus, not every render.
  }, [focus, focusIndex, rows.length]);
  useEffect(() => {
    scrollToRow(editIndex);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Bring each new edit into view once.
  }, [editId, editIndex < 0]);
  return virtualizer;
}
