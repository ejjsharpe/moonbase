import { getParentPath, getPathName } from '@moonbase/contracts/paths';
import type { CheckoutTarget, DirectoryEntry } from '@moonbase/contracts/workspace';
import { fold, planMove } from './files-tree-drop.ts';
import { measureStem } from './files-tree-rows.ts';

/** Entries cut or copied in a workbench's files tree, waiting to be pasted into a folder. */
export type FileClipboard = { checkout: CheckoutTarget; paths: string[]; mode: 'copy' | 'cut' };

/** What pasting into a folder does: move or copy entries, nothing, or refuse with a reason. */
export type PastePlan =
  | { kind: 'move'; paths: string[] }
  /** `paths` copy as one batch under their own names; each of `renamed` copies alone as `name`. */
  | { kind: 'copy'; paths: string[]; renamed: { path: string; name: string }[] }
  | { kind: 'none' }
  | { kind: 'refused'; message: string };

/**
 * The name of a copy of `name`: `name copy.ext` first, then `name copy 2.ext` and so on. A folder's
 * or dotfile's whole name is its stem.
 */
export function copyName(name: string, directory: boolean, count = 1) {
  const stem = measureStem(name, directory);
  return `${name.slice(0, stem)} copy${count > 1 ? ` ${count}` : ''}${name.slice(stem)}`;
}

/** The first copy name of `name` (see `copyName`) not in `taken`, a set of folded names. */
export function findFreeName(name: string, directory: boolean, taken: ReadonlySet<string>) {
  for (let count = 1; ; count++) {
    const candidate = copyName(name, directory, count);
    if (!taken.has(fold(candidate))) return candidate;
  }
}

/**
 * The folder a paste into `folder` lands in: a copied folder pasted onto itself lands beside it. A
 * cut stays on `folder`, where a move into one of its entries is refused.
 */
export const findPasteFolder = (
  mode: FileClipboard['mode'],
  paths: readonly string[],
  folder: string,
) => (mode === 'copy' && paths.includes(folder) ? getParentPath(folder) : folder);

/** Whether `folder` is strictly inside one of `paths`. */
export const isInside = (paths: readonly string[], folder: string) =>
  paths.some((path) => folder.startsWith(path + '/'));

/**
 * What pasting `sources` into `folder`, whose current entries are `entries`, does. A cut moves
 * them as a drop would, refusing a move into one of them or onto another's path, and doing nothing
 * when all are already there. A copy takes the entries whose names are free in `folder` as they
 * are, and gives each of the rest the first free copy name, as names fold in the workspace.
 */
export function planPaste(
  mode: FileClipboard['mode'],
  sources: readonly Pick<DirectoryEntry, 'path' | 'directory'>[],
  folder: string,
  entries: readonly Pick<DirectoryEntry, 'path'>[],
): PastePlan {
  const paths = sources.map((source) => source.path);
  if (mode === 'cut') {
    const plan = planMove(paths, folder);
    if ('paths' in plan) return { kind: 'move', paths: plan.paths };
    if (plan.refused === 'in-place') return { kind: 'none' };
    return {
      kind: 'refused',
      message:
        plan.refused === 'into-itself'
          ? 'Can’t move a folder into itself.'
          : 'Cut items with the same name can’t go into one folder.',
    };
  }
  if (isInside(paths, folder))
    return { kind: 'refused', message: 'Can’t copy a folder into itself.' };
  const taken = new Set(entries.map((entry) => fold(getPathName(entry.path))));
  const kept: string[] = [],
    colliding: Pick<DirectoryEntry, 'path' | 'directory'>[] = [];
  for (const source of sources) {
    const name = fold(getPathName(source.path));
    if (taken.has(name)) colliding.push(source);
    else {
      kept.push(source.path);
      taken.add(name);
    }
  }
  const renamed = colliding.map((source) => {
    const name = findFreeName(getPathName(source.path), source.directory, taken);
    taken.add(fold(name));
    return { path: source.path, name };
  });
  return { kind: 'copy', paths: kept, renamed };
}
