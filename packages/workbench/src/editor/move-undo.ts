import { useEffect, useRef, useState } from 'react';
import type { CheckoutTarget, DirectoryEntry } from '@moonbase/contracts/workspace';
import { checkoutKey, readOwn, type EditorController } from '@moonbase/application/editor';
import {
  describeUndo,
  findUndoProblem,
  listFoldersToExpand,
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
 * The last move or rename made from each open checkout's tree, and undoing it by moving the
 * entries back. One level per checkout; closing a checkout forgets its entry.
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
  const find = (checkout: CheckoutTarget) =>
    Object.hasOwn(records, checkoutKey(checkout)) ? records[checkoutKey(checkout)] : undefined;
  /** Forgets a checkout's move, unless a newer one replaced `expected`. */
  function forget(key: string, expected: MoveRecord) {
    setRecords((current) => {
      if (current[key] !== expected) return current;
      const { [key]: _, ...rest } = current;
      return rest;
    });
  }
  /**
   * Moves a checkout's last moved entries back and selects them. A move that can no longer be
   * undone, because an entry has gone or its original path is taken, reports why and is
   * forgotten; one declined or failing partway keeps what is left to undo. Resolves true once
   * undone.
   */
  async function undo(checkout: CheckoutTarget) {
    const key = checkoutKey(checkout),
      current = find(checkout);
    if (!current || undoing.current) return false;
    undoing.current = true;
    try {
      const folders = [
        ...new Set(current.moves.flatMap((move) => [parentOf(move.to), parentOf(move.from)])),
      ];
      const listings = new Map<string, readonly DirectoryEntry[]>();
      await Promise.all(
        folders.map((folder) =>
          controller.list(checkout, folder).then(
            (listing) => {
              if (!listing.error) listings.set(folder, listing.entries);
            },
            () => {},
          ),
        ),
      );
      const problem = findUndoProblem(current.moves, (folder) => listings.get(folder));
      if (problem) {
        controller.report(problem);
        forget(key, current);
        return false;
      }
      const restored: string[] = [];
      const steps = listUndoMoves(current.moves);
      for (const [index, step] of steps.entries()) {
        const completed = await runMutation(
          { checkout, kind: 'move', paths: step.paths },
          step.destination,
        );
        if (!completed) {
          const left = { ...current, moves: steps.slice(index).flatMap((step) => step.moves) };
          setRecords((records) =>
            records[key] === current ? { ...records, [key]: left } : records,
          );
          if (restored.length) selectEntries(controller, checkout, restored);
          return false;
        }
        restored.push(...step.moves.map((move) => move.from));
      }
      forget(key, current);
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
