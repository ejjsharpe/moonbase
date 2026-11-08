import { useEffect, useRef, useState } from 'react';
import type { CheckoutTarget, DirectoryEntry } from '@moonbase/contracts/workspace';
import { checkoutKey, readOwn, type EditorController } from '@moonbase/application/editor';
import {
  describeUndo,
  findUndoProblem,
  listFoldersToExpand,
  listTransferred,
  listUndoMoves,
  type MoveRecord,
} from './files-tree-drop.ts';
import type { RunMutation } from './mutation-runner.tsx';

const parentOf = (path: string) => path.split('/').slice(0, -1).join('/');

/**
 * Expands the folders that show `paths` in a checkout's tree, lists the newly expanded ones, and
 * selects `paths`, focusing the first.
 */
export function selectEntries(
  controller: EditorController,
  checkout: CheckoutTarget,
  paths: readonly string[],
) {
  const tree = readOwn(controller.getSnapshot().recovery.views, checkout.checkoutId)?.tree;
  if (!tree || !paths.length) return;
  const opening = [...new Set(paths.flatMap((path) => listFoldersToExpand(parentOf(path))))].filter(
    (folder) => !tree.expanded.includes(folder),
  );
  controller.tree(checkout, {
    expanded: [...tree.expanded, ...opening],
    focus: paths[0],
    selected: [...paths],
  });
  for (const folder of opening) void controller.list(checkout, folder).catch(controller.report);
}

/**
 * Lists the folders an undo or paste reads: each folder's entries, or none when it is gone. A
 * folder whose listing fails is gone only when its parent lists without it; otherwise, since it
 * may still be there, the result names it as `unlisted`.
 */
export async function listFolders(
  controller: EditorController,
  checkout: CheckoutTarget,
  folders: readonly string[],
) {
  type Read = readonly DirectoryEntry[] | 'gone' | 'unlisted';
  const reads = new Map<string, Promise<Read>>();
  const read = (folder: string): Promise<Read> => {
    const known = reads.get(folder);
    if (known) return known;
    const reading = (async (): Promise<Read> => {
      try {
        const listing = await controller.list(checkout, folder);
        if (!listing.error) return listing.entries;
      } catch {
        // The editor reports the failure; whether the folder is gone is decided below.
      }
      if (!folder) return 'unlisted';
      const parent = await read(parentOf(folder));
      if (parent === 'unlisted') return parent;
      if (parent === 'gone' || !parent.some((entry) => entry.path === folder && entry.directory))
        return 'gone';
      return 'unlisted';
    })();
    reads.set(folder, reading);
    return reading;
  };
  const listings = new Map<string, readonly DirectoryEntry[]>();
  let unlisted: string | undefined;
  for (const [index, entries] of (await Promise.all(folders.map(read))).entries()) {
    if (entries === 'unlisted') unlisted ??= folders[index];
    else if (entries !== 'gone') listings.set(folders[index], entries);
  }
  return { listings, unlisted };
}

/**
 * The last move or rename made from each open checkout's tree, and undoing it by moving the
 * entries back. One level per checkout: any other file operation from the tree or a dialog
 * forgets it, and so does closing the checkout.
 */
export function useMoveUndo(
  controller: EditorController,
  runMutation: RunMutation,
  openCheckouts: readonly CheckoutTarget[],
) {
  const [records, setRecords] = useState<Record<string, MoveRecord & { checkout: CheckoutTarget }>>(
    {},
  );
  const undoing = useRef(false);
  const openKeys = openCheckouts.map(checkoutKey);
  const openIdentity = JSON.stringify(openKeys);
  useEffect(() => {
    setRecords((current) => {
      const kept = Object.entries(current).filter(([key]) => openKeys.includes(key));
      return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept);
    });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `openIdentity` stands for the keys.
  }, [openIdentity]);
  /** Remembers a completed move or rename as the checkout's one to undo. */
  function record(checkout: CheckoutTarget, value: MoveRecord) {
    if (!value.moves.length) return;
    setRecords((current) => ({
      ...current,
      [checkoutKey(checkout)]: { ...structuredClone(value), checkout: { ...checkout } },
    }));
  }
  /** Forgets the checkout's move, as another file operation in it does. */
  function clear(checkout: CheckoutTarget) {
    const key = checkoutKey(checkout);
    setRecords((current) => {
      if (!Object.hasOwn(current, key)) return current;
      const { [key]: _, ...rest } = current;
      return rest;
    });
  }
  /**
   * Runs a file operation from the tree, forgetting the checkout's move unless the operation was
   * declined without effect. A move or rename it makes is recorded afterwards by the caller.
   */
  const run: RunMutation = async (action, destination, options) => {
    const result = await runMutation(action, destination, options);
    if (result.completed || result.error || result.items.length) clear(action.checkout);
    return result;
  };
  const find = (checkout: CheckoutTarget) =>
    Object.hasOwn(records, checkoutKey(checkout)) ? records[checkoutKey(checkout)] : undefined;
  /** Replaces a checkout's move with `next`, or forgets it, unless a newer one replaced `expected`. */
  function settle(key: string, expected: MoveRecord, next?: MoveRecord) {
    setRecords((current) => {
      if (current[key] !== expected) return current;
      if (next?.moves.length) return { ...current, [key]: { ...current[key], ...next } };
      const { [key]: _, ...rest } = current;
      return rest;
    });
  }
  /**
   * Moves a checkout's last moved entries back and selects them. A move that can no longer be
   * undone, because an entry has gone or its original path is taken, reports why and is
   * forgotten; one whose folders can't be listed reports that and is kept. One declined or failing
   * partway keeps exactly the entries still to move back. A replace prompt returns focus to
   * `finalFocus`. Resolves true once undone.
   */
  async function undo(checkout: CheckoutTarget, finalFocus?: () => HTMLElement | false) {
    const key = checkoutKey(checkout),
      current = find(checkout);
    if (!current || undoing.current) return false;
    undoing.current = true;
    try {
      const folders = [
        ...new Set(current.moves.flatMap((move) => [parentOf(move.to), parentOf(move.from)])),
      ];
      const { listings, unlisted } = await listFolders(controller, checkout, folders);
      if (unlisted !== undefined) {
        controller.report(
          `Can’t undo the move yet: ${unlisted || 'the checkout’s root'} couldn’t be listed. Try again.`,
        );
        return false;
      }
      const problem = findUndoProblem(current.moves, (folder) => listings.get(folder));
      if (problem) {
        controller.report(problem);
        settle(key, current);
        return false;
      }
      const restored: string[] = [];
      const steps = listUndoMoves(current.moves);
      for (const [index, step] of steps.entries()) {
        const result = await runMutation(
          { checkout, kind: 'move', paths: step.paths },
          step.destination,
          finalFocus ? { finalFocus } : {},
        );
        if (!result.completed) {
          const back = new Set(listTransferred(step.paths, result));
          restored.push(...step.moves.filter((move) => back.has(move.to)).map((move) => move.from));
          const left = [
            ...step.moves.filter((move) => !back.has(move.to)),
            ...steps.slice(index + 1).flatMap((step) => step.moves),
          ];
          settle(key, current, { ...current, moves: left });
          if (restored.length) selectEntries(controller, checkout, restored);
          return false;
        }
        restored.push(...step.moves.map((move) => move.from));
      }
      settle(key, current);
      selectEntries(controller, checkout, restored);
      return true;
    } catch (error) {
      controller.report(error);
      return false;
    } finally {
      undoing.current = false;
    }
  }
  return {
    record,
    clear,
    run,
    undo,
    /** What undoing the checkout's last move does, such as "Undo Rename", or undefined. */
    labelFor: (checkout: CheckoutTarget) => {
      const current = find(checkout);
      return current && describeUndo(current);
    },
    /** The paths the checkout's last move put its entries at. */
    movedPaths: (checkout: CheckoutTarget) => find(checkout)?.moves.map((move) => move.to) ?? [],
  };
}
