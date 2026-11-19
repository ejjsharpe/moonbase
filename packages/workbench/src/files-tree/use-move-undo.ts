import { getParentPath } from '@moonbase/contracts/paths';
import { useEffect, useRef, useState } from 'react';
import { Effect } from 'effect';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { checkoutKey } from '@moonbase/application/editor';
import {
  describeUndo,
  findUndoProblem,
  listTransferred,
  listUndoMoves,
  type MoveRecord,
} from './files-tree-drop.ts';
import { listFolders } from './list-folders.ts';
import { selectEntries } from './select-entries.ts';
import type { RunMutation } from '../mutation-runner.tsx';
import type { EditorActions } from '../editor-actions.ts';

/**
 * The last move or rename made from each open checkout's tree, and undoing it by moving the
 * entries back. One level per checkout: any other file operation from the tree or a dialog
 * forgets it, and so does closing the checkout.
 */
export function useMoveUndo(
  actions: EditorActions,
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
   * declined without effect. A move or rename it makes is recorded by the caller's `settled`, in
   * the same step, so a caller gone meanwhile still leaves Undo the move it made.
   */
  const run: RunMutation = (action, destination, options) =>
    runMutation(action, destination, {
      ...options,
      settled: (result) => {
        if (result.completed || result.error || result.items.length) clear(action.checkout);
        options?.settled?.(result);
      },
    });
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
   * `finalFocus`. Succeeds true once undone.
   */
  const undo = (checkout: CheckoutTarget, finalFocus?: () => HTMLElement | false) =>
    Effect.suspend(() => {
      const key = checkoutKey(checkout),
        current = find(checkout);
      if (!current || undoing.current) return Effect.succeed(false);
      undoing.current = true;
      // The moves back and the record they leave are the editor's own; selecting what came back
      // is the caller's, and goes with it.
      return actions
        .own(
          Effect.gen(function* () {
            const folders = [
              ...new Set(
                current.moves.flatMap((move) => [getParentPath(move.to), getParentPath(move.from)]),
              ),
            ];
            const { listings, unlisted } = yield* listFolders(actions, checkout, folders);
            if (unlisted !== undefined) {
              actions.report(
                `Can’t undo the move yet: ${unlisted || 'the checkout’s root'} couldn’t be listed. Try again.`,
              );
              return { undone: false, restored: [] };
            }
            const problem = findUndoProblem(current.moves, (folder) => listings.get(folder));
            if (problem) {
              actions.report(problem);
              settle(key, current);
              return { undone: false, restored: [] };
            }
            const restored: string[] = [];
            const steps = listUndoMoves(current.moves);
            for (const [index, step] of steps.entries()) {
              const result = yield* runMutation(
                { checkout, kind: 'move', paths: step.paths },
                step.destination,
                finalFocus ? { finalFocus } : {},
              );
              if (!result.completed) {
                const back = new Set(listTransferred(step.paths, result));
                restored.push(
                  ...step.moves.filter((move) => back.has(move.to)).map((move) => move.from),
                );
                const left = [
                  ...step.moves.filter((move) => !back.has(move.to)),
                  ...steps.slice(index + 1).flatMap((step) => step.moves),
                ];
                settle(key, current, { ...current, moves: left });
                return { undone: false, restored };
              }
              restored.push(...step.moves.map((move) => move.from));
            }
            settle(key, current);
            return { undone: true, restored };
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                undoing.current = false;
              }),
            ),
          ),
        )
        .pipe(
          Effect.map(({ undone, restored }) => {
            if (restored.length) selectEntries(actions, checkout, restored);
            return undone;
          }),
        );
    });
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
