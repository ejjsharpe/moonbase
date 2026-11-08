import type { DirectoryEntry, DirectoryListing } from '@moonbase/contracts/workspace';

/** Each tree row's height in pixels. */
export const rowHeight = 28;
/** Rows mounted beyond each edge of the scrolled window. */
const overscan = 10;

/** A listed entry the tree shows, with its place among its siblings. */
export type VisibleRow = DirectoryEntry & { level: number; position: number; size: number };

/** A checkout's tree in display order: listed entries, descending into expanded folders. */
export function listVisibleRows(
  listings: Readonly<Record<string, DirectoryListing>>,
  checkoutIdentity: string,
  expanded: ReadonlySet<string>,
) {
  const rows: VisibleRow[] = [];
  function visit(parent: string, level: number) {
    const entries = listings[JSON.stringify([checkoutIdentity, parent])]?.entries ?? [];
    entries.forEach((entry, index) => {
      rows.push({ ...entry, level, position: index + 1, size: entries.length });
      if (entry.directory && expanded.has(entry.path)) visit(entry.path, level + 1);
    });
  }
  visit('', 1);
  return rows;
}

/**
 * The indexes of the rows to mount, in order: those in or near the scrolled window, the focused
 * row, and any `pinnedPaths` that are visible rows, however far they are scrolled away.
 */
export function selectMountedIndexes({
  rows,
  top,
  height,
  focusIndex,
  pinnedPaths = [],
}: {
  rows: readonly VisibleRow[];
  top: number;
  height: number;
  focusIndex: number;
  pinnedPaths?: Iterable<string>;
}) {
  const indexes = new Set<number>([focusIndex]);
  for (
    let index = Math.max(0, Math.floor(top / rowHeight) - overscan);
    index < Math.min(rows.length, Math.ceil((top + height) / rowHeight) + overscan);
    index++
  )
    indexes.add(index);
  const pinned = new Set(pinnedPaths);
  if (pinned.size)
    rows.forEach((row, index) => {
      if (pinned.has(row.path)) indexes.add(index);
    });
  return [...indexes].filter((index) => index < rows.length).sort((a, b) => a - b);
}
