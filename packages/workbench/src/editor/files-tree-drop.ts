import type { DirectoryEntry } from '@moonbase/contracts/workspace';
import type { MutationRunResult } from '@moonbase/application/editor';

/** The DataTransfer type of entries dragged from a files tree: a JSON `TreeDrag`. */
export const entriesType = 'application/x-moonbase-entries';

/** The most entries one move or copy takes, and so one drag. */
export const maxDraggedEntries = 128;

/** Entries dragged from one tree: `source` is its editor instance, `checkout` its checkout key. */
export type TreeDrag = { source: string; checkout: string; paths: string[] };

/**
 * Whether a drop's DataTransfer `data` (its `entriesType` text) is `drag`, the drag this document
 * started: the same tree, checkout and paths.
 */
export function isSameDrag(data: string, drag: TreeDrag | null) {
  if (!drag || !data) return false;
  let dropped: unknown;
  try {
    dropped = JSON.parse(data);
  } catch {
    return false;
  }
  if (typeof dropped !== 'object' || !dropped) return false;
  const { source, checkout, paths } = dropped as Partial<TreeDrag>;
  return (
    source === drag.source &&
    checkout === drag.checkout &&
    Array.isArray(paths) &&
    paths.length === drag.paths.length &&
    paths.every((path, index) => path === drag.paths[index])
  );
}

/** An entry moved from the tree, for undoing the move. */
export type TreeMove = { from: string; to: string; directory: boolean };

/** One move the tree can undo: the entries it moved and what it was. */
export type MoveRecord = { kind: 'rename' | 'move'; moves: TreeMove[] };

const parentOf = (path: string) => path.split('/').slice(0, -1).join('/');
const nameOf = (path: string) => path.split('/').at(-1)!;
const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
/** Whether `path` is `folder` or inside it; every path is inside the root, ''. */
const within = (path: string, folder: string) =>
  !folder || path === folder || path.startsWith(folder + '/');
const fold = (path: string) => path.normalize('NFC').toLowerCase();

/**
 * What dragging the row at `path` drags: the whole selection when the row is selected, else just
 * the row. Entries inside another dragged folder are left out, since they move with it.
 */
export function selectDraggedPaths(path: string, selection: readonly string[]) {
  const paths = selection.includes(path) ? [...new Set(selection)] : [path];
  return paths.filter((path) => !paths.some((other) => other !== path && within(path, other)));
}

/** The folder a drop over `row` lands in: a folder row's own, a file row's parent, else the root. */
export function findDropFolder(row?: Pick<DirectoryEntry, 'path' | 'directory'>) {
  if (!row) return '';
  return row.directory ? row.path : parentOf(row.path);
}

/**
 * The entries a drop into `folder` moves or copies, or null to refuse it: a drag from another
 * editor or checkout, a drop onto a dragged entry or into one of its folders, a drop where every
 * dragged entry is already in `folder`, and one that would land an entry on another dragged
 * entry's path (as the workspace folds names). Entries already there are left out of the rest.
 */
export function planDrop(
  drag: TreeDrag | null,
  target: { source: string; checkout: string; folder: string },
) {
  if (!drag || drag.source !== target.source || drag.checkout !== target.checkout) return null;
  const { folder } = target;
  if (drag.paths.some((path) => folder === path || folder.startsWith(path + '/'))) return null;
  const paths = drag.paths.filter((path) => parentOf(path) !== folder);
  const dragged = new Set(drag.paths.map(fold));
  if (listDroppedPaths(paths, folder).some((path) => dragged.has(fold(path)))) return null;
  return paths.length ? paths : null;
}

/**
 * Which of `paths` a move or copy took: all of them once it completed, else those its items
 * report completed, as a batch that failed partway does.
 */
export function listTransferred(
  paths: readonly string[],
  result: Pick<MutationRunResult, 'completed' | 'items'>,
) {
  if (result.completed) return [...paths];
  const done = new Set(
    result.items
      .filter((item) => item.outcome === 'completed' && item.destination !== undefined)
      .map((item) => item.source),
  );
  return paths.filter((path) => done.has(path));
}

/** Whether a row belongs to the highlighted region of a drop into `folder`, other than the root. */
export const isInDropRegion = (path: string, folder: string | null) =>
  !!folder && within(path, folder);

/**
 * The destination a move or copy of `paths` into `folder` takes: the folder for several entries
 * ('' for the root), the entry's new path for one.
 */
export const getDropDestination = (paths: readonly string[], folder: string) =>
  paths.length > 1 ? folder : join(folder, nameOf(paths[0]));

/** Where each of `paths` lands in `folder`. */
export const listDroppedPaths = (paths: readonly string[], folder: string) =>
  paths.map((path) => join(folder, nameOf(path)));

/** The folders to expand to show `path`'s row: each ancestor, and `path` itself. */
export function listFoldersToExpand(path: string) {
  const parts = path ? path.split('/') : [];
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

/** The explorer menu's label for undoing `record`: Undo Rename, Undo Move, Undo Move of 3 Items. */
export function describeUndo(record: MoveRecord) {
  if (record.kind === 'rename') return 'Undo Rename';
  return record.moves.length > 1 ? `Undo Move of ${record.moves.length} Items` : 'Undo Move';
}

/**
 * The moves that undo `moves`: one per original folder, moving the entries back as a batch into
 * that folder, or a single entry back to its exact path.
 */
export function listUndoMoves(moves: readonly TreeMove[]) {
  const groups = new Map<string, TreeMove[]>();
  for (const move of moves) {
    const parent = parentOf(move.from);
    groups.set(parent, [...(groups.get(parent) ?? []), move]);
  }
  return [...groups].map(([parent, group]) => ({
    paths: group.map((move) => move.to),
    destination: group.length > 1 ? parent : group[0].from,
    moves: group,
  }));
}

/**
 * Why `moves` can't be undone, or '' when they can: each moved entry must still be at its new
 * path, as the same kind of entry, and each original path must be free. `entriesIn` gives a
 * folder's fresh listing, or undefined when the folder is gone.
 */
export function findUndoProblem(
  moves: readonly TreeMove[],
  entriesIn: (folder: string) => readonly DirectoryEntry[] | undefined,
) {
  for (const move of moves) {
    const entry = entriesIn(parentOf(move.to))?.find((entry) => entry.path === move.to);
    if (!entry || entry.directory !== move.directory)
      return `Can’t undo the move: ${move.to} is no longer there.`;
  }
  for (const move of moves) {
    const entries = entriesIn(parentOf(move.from));
    if (!entries) return `Can’t undo the move: the folder ${parentOf(move.from)} is gone.`;
    // A rename that only changed case leaves its original spelling free.
    if (entries.some((entry) => fold(entry.path) === fold(move.from) && entry.path !== move.to))
      return `Can’t undo the move: ${move.from} is taken.`;
  }
  return '';
}
