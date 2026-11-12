import { getParentPath, getPathName, joinPath } from '@moonbase/contracts/paths';
import { useRef, useState } from 'react';
import type { CheckoutTarget, DirectoryEntry } from '@moonbase/contracts/workspace';
import {
  checkoutKey,
  type EditorController,
  type MutationAction,
} from '@moonbase/application/editor';
import {
  fold,
  getDropDestination,
  listDroppedPaths,
  listTransferred,
  maxDraggedEntries,
  planMove,
  selectDraggedPaths,
  type MoveRecord,
} from './files-tree-drop.ts';
import { measureStem } from './files-tree-rows.ts';
import { listFolders, selectEntries } from './move-undo.ts';
import type { RunMutation } from './mutation-runner.tsx';

/** Entries cut or copied in a workbench's files tree, waiting to be pasted into a folder. */
export type FileClipboard = { checkout: CheckoutTarget; paths: string[]; mode: 'copy' | 'cut' };

/** What pasting into a folder does: move or copy entries, nothing, or refuse with a reason. */
export type PastePlan =
  | { kind: 'move'; paths: string[] }
  /** `paths` copy as one batch under their own names; each of `renamed` copies alone as `name`. */
  | { kind: 'copy'; paths: string[]; renamed: { path: string; name: string }[] }
  | { kind: 'none' }
  | { kind: 'refused'; message: string };

const unavailable =
  'File action unavailable. Check the selection and finish the current editor dialog or preservation.';

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
const isInside = (paths: readonly string[], folder: string) =>
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

/**
 * A workbench's file clipboard: entries cut or copied in its tree, and pasting them into a folder
 * of the same checkout. It is the workbench's own, not the OS clipboard, which gets the entries'
 * relative paths as text through `copyPaths` when the app supplies it. Pasting runs through
 * `runMutation`, one operation at a time; a pasted cut is recorded with `recordMove` for undo.
 */
export function useFileClipboard({
  controller,
  runMutation,
  recordMove,
  canRequestMutation,
  copyPaths,
}: {
  controller: EditorController;
  runMutation: RunMutation;
  recordMove: (checkout: CheckoutTarget, record: MoveRecord) => void;
  canRequestMutation: (action: MutationAction) => boolean;
  copyPaths?: (checkout: CheckoutTarget, paths: string[], relative: boolean) => Promise<void>;
}) {
  const [clipboard, setClipboard] = useState<FileClipboard | null>(null);
  const latest = useRef(clipboard),
    pasting = useRef(false);
  function update(next: FileClipboard | null) {
    latest.current = next;
    setClipboard(next);
  }
  /** Forgets `expected` unless something newer replaced it. */
  function forget(expected: FileClipboard) {
    if (latest.current === expected) update(null);
  }
  /** Puts a checkout's entries on the clipboard to copy or move, leaving out those inside another. */
  function put(checkout: CheckoutTarget, paths: readonly string[], mode: FileClipboard['mode']) {
    const entries = paths.length ? selectDraggedPaths(paths[0], paths) : [];
    if (!entries.length) return;
    if (entries.length > maxDraggedEntries) {
      controller.report(`Cut or copy at most ${maxDraggedEntries} items at a time.`);
      return;
    }
    update({ checkout: { ...checkout }, paths: entries, mode });
    // The OS clipboard no longer holds files copied earlier, so ⌘V pastes these.
    if (copyPaths) void copyPaths(checkout, entries, true).catch(controller.report);
  }
  /** Clears a pending cut in `checkout`; true when there was one. */
  function cancelCut(checkout: CheckoutTarget) {
    const current = latest.current;
    if (current?.mode !== 'cut' || checkoutKey(current.checkout) !== checkoutKey(checkout))
      return false;
    update(null);
    return true;
  }
  const kindOf = (value: FileClipboard) => (value.mode === 'cut' ? 'move' : 'copy');
  /** Whether the clipboard holds entries a paste into a checkout's `folder` would take. */
  function canPaste(checkout: CheckoutTarget, folder: string) {
    const current = clipboard;
    if (!current || checkoutKey(current.checkout) !== checkoutKey(checkout)) return false;
    if (!canRequestMutation({ checkout, kind: kindOf(current), paths: current.paths }))
      return false;
    const into = findPasteFolder(current.mode, current.paths, folder);
    return current.mode === 'cut'
      ? 'paths' in planMove(current.paths, into)
      : !isInside(current.paths, into);
  }
  /**
   * Pastes the clipboard into a checkout's `folder` and selects what landed, resolving with it. A
   * cut moves, asking before replacing entries, and is then cleared; a copy picks free names.
   * Entries that have gone are forgotten; ones whose folders can't be listed are kept. A replace
   * prompt returns focus to `finalFocus`.
   */
  async function paste(
    checkout: CheckoutTarget,
    folder: string,
    finalFocus?: () => HTMLElement | false,
  ): Promise<string[]> {
    const current = latest.current;
    if (!current || pasting.current) return [];
    if (checkoutKey(current.checkout) !== checkoutKey(checkout)) {
      controller.report(
        'Can’t paste into another checkout. Cut or copy items from this checkout’s files first.',
      );
      return [];
    }
    if (!canRequestMutation({ checkout, kind: kindOf(current), paths: current.paths })) {
      controller.report(unavailable);
      return [];
    }
    pasting.current = true;
    try {
      const into = findPasteFolder(current.mode, current.paths, folder);
      const { listings, unlisted } = await listFolders(controller, checkout, [
        ...new Set([into, ...current.paths.map(getParentPath)]),
      ]);
      // Entries that may still be there stay on the clipboard to paste once they list again.
      if (unlisted !== undefined) {
        controller.report(
          `Can’t paste yet: ${unlisted || 'the checkout’s root'} couldn’t be listed. Try again.`,
        );
        return [];
      }
      const sources: DirectoryEntry[] = [],
        missing: string[] = [];
      for (const path of current.paths) {
        const entry = listings.get(getParentPath(path))?.find((entry) => entry.path === path);
        if (entry) sources.push(entry);
        else missing.push(path);
      }
      if (missing.length) {
        controller.report(
          missing.length === 1
            ? `Can’t paste: ${missing[0]} no longer exists.`
            : `Can’t paste: ${missing.length} of the items no longer exist.`,
        );
        forget(current);
        return [];
      }
      const entries = listings.get(into);
      if (!entries) {
        controller.report(`Can’t paste: ${into || 'the checkout’s root'} no longer exists.`);
        return [];
      }
      const plan = planPaste(current.mode, sources, into, entries);
      if (plan.kind === 'refused') controller.report(plan.message);
      if (plan.kind === 'refused' || plan.kind === 'none') return [];
      const options = finalFocus ? { finalFocus } : {};
      const landed: string[] = [];
      if (plan.kind === 'move') {
        const result = await runMutation(
          { checkout, kind: 'move', paths: plan.paths },
          getDropDestination(plan.paths, into),
          options,
        );
        const moved = listTransferred(plan.paths, result);
        landed.push(...listDroppedPaths(moved, into));
        if (moved.length) {
          const directories = new Map(sources.map((entry) => [entry.path, entry.directory]));
          recordMove(checkout, {
            kind: 'move',
            moves: moved.map((from, index) => ({
              from,
              to: landed[index],
              directory: directories.get(from)!,
            })),
          });
          forget(current);
        }
      } else {
        let completed = true;
        if (plan.paths.length) {
          const result = await runMutation(
            { checkout, kind: 'copy', paths: plan.paths },
            getDropDestination(plan.paths, into),
            options,
          );
          landed.push(...listDroppedPaths(listTransferred(plan.paths, result), into));
          completed = result.completed;
        }
        // A batch copies into a folder under the entries' own names, so each renamed copy is its own.
        for (const { path, name } of completed ? plan.renamed : []) {
          const destination = joinPath(into, name);
          const result = await runMutation(
            { checkout, kind: 'copy', paths: [path] },
            destination,
            options,
          );
          if (!result.completed) break;
          landed.push(destination);
        }
      }
      if (landed.length) selectEntries(controller, checkout, landed);
      return landed;
    } finally {
      pasting.current = false;
    }
  }
  return { clipboard, put, cancelCut, canPaste, paste };
}
