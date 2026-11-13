import type { DirectoryEntry, DirectoryListing } from '@moonbase/contracts/workspace';

/** Each tree row's height in pixels. */
export const rowHeight = 28;
/** Rows mounted beyond each edge of the scrolled window. */
const overscan = 10;

/** A listed entry the tree shows, with its place among its siblings. */
export type VisibleRow = DirectoryEntry & {
  level: number;
  position: number;
  size: number;
  /** Set on the row where a new entry's name is typed; it has no entry on disk. */
  placeholder?: true;
};

/** Where a new entry's name is typed: first in `parent`, or right after its entry `after`. */
export type RowPlaceholder = { parent: string; directory: boolean; after?: string };

/** The placeholder row's path in `parent`; no listed entry can have it. */
export const placeholderPath = (parent: string) => (parent ? `${parent}/` : '') + '\0';

/**
 * A checkout's tree in display order: listed entries, descending into expanded folders, with an
 * optional `placeholder` row among its parent's children when that parent is shown. With
 * `hideIgnored`, entries Git has classified as ignored are left out, with all they contain.
 */
export function listVisibleRows(
  listings: Readonly<Record<string, DirectoryListing>>,
  checkoutIdentity: string,
  expanded: ReadonlySet<string>,
  placeholder?: RowPlaceholder,
  hideIgnored = false,
) {
  const rows: VisibleRow[] = [];
  function visit(parent: string, level: number) {
    let entries: (DirectoryEntry & { placeholder?: true })[] =
      listings[JSON.stringify([checkoutIdentity, parent])]?.entries ?? [];
    if (hideIgnored) entries = entries.filter((entry) => !entry.ignored);
    if (placeholder?.parent === parent) {
      const index =
        placeholder.after === undefined
          ? 0
          : entries.findIndex((entry) => entry.path === placeholder.after) + 1;
      entries = [
        ...entries.slice(0, index),
        { path: placeholderPath(parent), directory: placeholder.directory, placeholder: true },
        ...entries.slice(index),
      ];
    }
    entries.forEach((entry, index) => {
      rows.push({ ...entry, level, position: index + 1, size: entries.length });
      if (entry.directory && expanded.has(entry.path)) visit(entry.path, level + 1);
    });
  }
  visit('', 1);
  return rows;
}

/**
 * Where `path` shows while ignored entries are hidden: itself, or the folder holding its
 * outermost ignored ancestor (or itself, when it is ignored), as far as the listings say.
 */
export function findShownPath(
  listings: Readonly<Record<string, DirectoryListing>>,
  checkoutIdentity: string,
  path: string,
) {
  const parts = path ? path.split('/') : [];
  for (let index = 0; index < parts.length; index++) {
    const parent = parts.slice(0, index).join('/'),
      level = parts.slice(0, index + 1).join('/');
    const entry = listings[JSON.stringify([checkoutIdentity, parent])]?.entries.find(
      (item) => item.path === level,
    );
    if (entry?.ignored) return parent;
  }
  return path;
}

/**
 * The folder New File/Folder starts in from the tree's focused path: that folder, a file's
 * folder, or the checkout root when nothing listed is focused.
 */
export function findCreateFolder(
  listings: Readonly<Record<string, DirectoryListing>>,
  checkoutIdentity: string,
  focus: string,
) {
  const parent = focus.split('/').slice(0, -1).join('/');
  const entry = listings[JSON.stringify([checkoutIdentity, parent])]?.entries.find(
    (entry) => entry.path === focus,
  );
  if (!entry) return '';
  return entry.directory ? entry.path : parent;
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

/** The length of a name's stem, which is selected first: all of a folder's or dotfile's name. */
export function measureStem(name: string, directory: boolean) {
  const dot = name.lastIndexOf('.');
  return directory || dot <= 0 ? name.length : dot;
}
