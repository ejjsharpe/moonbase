import { getParentPath, joinPath } from '@moonbase/contracts/paths';
import { useRef, useState } from 'react';
import { Effect } from 'effect';
import type { CheckoutTarget, DirectoryEntry } from '@moonbase/contracts/workspace';
import {
  checkoutKey,
  mutationUnavailable,
  type MutationAction,
} from '@moonbase/application/editor';
import {
  getDropDestination,
  listDroppedPaths,
  listTransferred,
  maxDraggedEntries,
  planMove,
  selectDraggedPaths,
  type MoveRecord,
} from './files-tree-drop.ts';
import { findPasteFolder, isInside, planPaste, type FileClipboard } from './paste-plan.ts';
import { listFolders } from './list-folders.ts';
import { selectEntries } from './select-entries.ts';
import type { RunMutation } from '../mutation-runner.tsx';
import type { EditorActions } from '../editor-actions.ts';

/**
 * A workbench's file clipboard: entries cut or copied in its tree, and pasting them into a folder
 * of the same checkout. It is the workbench's own, not the OS clipboard, which gets the entries'
 * relative paths as text through the platform's `copyPaths` when the app supplies it. Pasting runs through
 * `runMutation`, one operation at a time; a pasted cut is recorded with `recordMove` for undo.
 */
export function useFileClipboard({
  actions,
  runMutation,
  recordMove,
  canRequestMutation,
}: {
  actions: EditorActions;
  runMutation: RunMutation;
  recordMove: (checkout: CheckoutTarget, record: MoveRecord) => void;
  canRequestMutation: (action: MutationAction) => boolean;
}) {
  const { copyPaths } = actions.platform;
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
      actions.report(`Cut or copy at most ${maxDraggedEntries} items at a time.`);
      return;
    }
    update({ checkout: { ...checkout }, paths: entries, mode });
    // The OS clipboard no longer holds files copied earlier, so ⌘V pastes these.
    if (copyPaths) actions.start(copyPaths(checkout, entries, true));
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
   * Pastes the clipboard into a checkout's `folder` and selects what landed, succeeding with it. A
   * cut moves, asking before replacing entries, and is then cleared; a copy picks free names.
   * Entries that have gone are forgotten; ones whose folders can't be listed are kept. A replace
   * prompt returns focus to `finalFocus`.
   */
  const paste = (
    checkout: CheckoutTarget,
    folder: string,
    finalFocus?: () => HTMLElement | false,
  ): Effect.Effect<string[]> =>
    Effect.suspend(() => {
      const current = latest.current;
      if (!current || pasting.current) return Effect.succeed([]);
      if (checkoutKey(current.checkout) !== checkoutKey(checkout)) {
        actions.report(
          'Can’t paste into another checkout. Cut or copy items from this checkout’s files first.',
        );
        return Effect.succeed([]);
      }
      if (!canRequestMutation({ checkout, kind: kindOf(current), paths: current.paths })) {
        actions.report(mutationUnavailable);
        return Effect.succeed([]);
      }
      pasting.current = true;
      return Effect.gen(function* () {
        const into = findPasteFolder(current.mode, current.paths, folder);
        const { listings, unlisted } = yield* listFolders(actions, checkout, [
          ...new Set([into, ...current.paths.map(getParentPath)]),
        ]);
        // Entries that may still be there stay on the clipboard to paste once they list again.
        if (unlisted !== undefined) {
          actions.report(
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
          actions.report(
            missing.length === 1
              ? `Can’t paste: ${missing[0]} no longer exists.`
              : `Can’t paste: ${missing.length} of the items no longer exist.`,
          );
          forget(current);
          return [];
        }
        const entries = listings.get(into);
        if (!entries) {
          actions.report(`Can’t paste: ${into || 'the checkout’s root'} no longer exists.`);
          return [];
        }
        const plan = planPaste(current.mode, sources, into, entries);
        if (plan.kind === 'refused') actions.report(plan.message);
        if (plan.kind === 'refused' || plan.kind === 'none') return [];
        const options = finalFocus ? { finalFocus } : {};
        const landed: string[] = [];
        if (plan.kind === 'move') {
          // The pasted cut is Undo's to record and the clipboard's to forget, even if the view
          // that pasted goes meanwhile.
          const result = yield* runMutation(
            { checkout, kind: 'move', paths: plan.paths },
            getDropDestination(plan.paths, into),
            {
              ...options,
              settled: (result) => {
                const moved = listTransferred(plan.paths, result);
                if (!moved.length) return;
                const to = listDroppedPaths(moved, into);
                const directories = new Map(sources.map((entry) => [entry.path, entry.directory]));
                recordMove(checkout, {
                  kind: 'move',
                  moves: moved.map((from, index) => ({
                    from,
                    to: to[index],
                    directory: directories.get(from)!,
                  })),
                });
                forget(current);
              },
            },
          );
          landed.push(...listDroppedPaths(listTransferred(plan.paths, result), into));
        } else {
          let completed = true;
          if (plan.paths.length) {
            const result = yield* runMutation(
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
            const result = yield* runMutation(
              { checkout, kind: 'copy', paths: [path] },
              destination,
              options,
            );
            if (!result.completed) break;
            landed.push(destination);
          }
        }
        if (landed.length) selectEntries(actions, checkout, landed);
        return landed;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pasting.current = false;
          }),
        ),
      );
    });
  return { clipboard, put, cancelCut, canPaste, paste };
}
