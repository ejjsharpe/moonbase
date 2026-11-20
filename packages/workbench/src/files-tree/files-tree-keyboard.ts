import type { KeyboardEvent, RefObject } from 'react';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import type { FileCommand } from './file-commands.ts';
import { isCommandKey, shortcutCommand } from '../shortcuts.ts';
import type { VisibleRow } from './files-tree-rows.ts';
import type { EditorActions } from '../editor-actions.ts';
import type { WorkbenchWork } from '../workbench-editor.ts';

/** What the tree's keyboard and pointer selection read and act on. */
export type TreeNavigation = {
  actions: EditorActions;
  /** Runs the tree's work for as long as it shows. */
  run: (work: WorkbenchWork) => void;
  checkout: CheckoutTarget;
  rows: readonly VisibleRow[];
  focusIndex: number;
  /** The checkout's selected paths, in the order they were selected. */
  selection: readonly string[];
  expanded: ReadonlySet<string>;
  /** Where a Shift-extended selection starts; null until a row sets it. */
  anchor: RefObject<string | null>;
  toggle(path: string, select?: boolean): void;
  /** Opens the context menu below the row for `path`. */
  openMenuBelow(path: string): void;
  commandsFor(paths: string[]): (FileCommand | 'separator')[];
  /** Undoes the tree's last move or rename (⌘Z, Ctrl+Z off a Mac). */
  undo(): void;
  /** Clears a pending cut (Escape); true when there was one. */
  cancelCut(): boolean;
};

/** Whether a press is Undo: ⌘Z on a Mac, Ctrl+Z elsewhere. */
const isUndoKey = (event: KeyboardEvent<HTMLElement>) => isCommandKey(event, 'z');

/** Moves focus and selection, expands and collapses, opens, and runs file shortcuts. */
export function handleTreeKeyDown(event: KeyboardEvent<HTMLElement>, navigation: TreeNavigation) {
  if (!event.currentTarget.contains(event.target as Node)) return;
  if (isUndoKey(event)) {
    event.preventDefault();
    navigation.undo();
    return;
  }
  const { actions, checkout, rows, focusIndex, selection, expanded, anchor, toggle } = navigation;
  const row = rows[focusIndex];
  if (!row) return;
  let next = focusIndex;
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    event.preventDefault();
    event.stopPropagation();
    navigation.openMenuBelow(row.path);
  } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    if (event.key === 'Home') {
      next = 0;
    } else {
      if (event.key === 'End') {
        next = rows.length - 1;
      } else {
        next = Math.max(
          0,
          Math.min(rows.length - 1, focusIndex + (event.key === 'ArrowDown' ? 1 : -1)),
        );
      }
    }
    if (!event.shiftKey || anchor.current === null) anchor.current = row.path;
    const anchorIndex = rows.findIndex((row) => row.path === anchor.current);
    const start = anchorIndex < 0 ? focusIndex : anchorIndex;
    const selected = event.shiftKey
      ? rows.slice(Math.min(start, next), Math.max(start, next) + 1).map((row) => row.path)
      : [rows[next].path];
    if (!event.shiftKey) anchor.current = rows[next].path;
    actions.tree(checkout, { focus: rows[next].path, selected });
  } else if (event.key === 'ArrowRight' && row.directory) {
    anchor.current = null;
    event.preventDefault();
    if (!expanded.has(row.path)) toggle(row.path);
  } else if (event.key === 'ArrowLeft') {
    anchor.current = null;
    event.preventDefault();
    if (row.directory && expanded.has(row.path)) toggle(row.path);
    else actions.tree(checkout, { focus: row.path.split('/').slice(0, -1).join('/') });
  } else if (shortcutCommand(event)) {
    event.preventDefault();
    const paths = selection.includes(row.path) ? [...selection] : [row.path];
    const command = navigation
      .commandsFor(paths)
      .find((item) => item !== 'separator' && item.keys === shortcutCommand(event));
    if (command && command !== 'separator' && !command.disabled) command.run();
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (row.directory) toggle(row.path);
    else
      navigation.run(
        actions.open(
          { checkout, path: row.path },
          { view: 'file', intent: event.key === ' ' ? 'preview' : 'keep' },
        ),
      );
  } else if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    if (navigation.cancelCut()) event.preventDefault();
  } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    actions.tree(checkout, { selected: rows.map((row) => row.path) });
  }
}

/**
 * Selects a clicked row: alone, toggling a folder and previewing a file, or, when `additive`
 * (⌘-click), added to or removed from the selection.
 */
export function handleRowClick(navigation: TreeNavigation, row: VisibleRow, additive: boolean) {
  const { actions, checkout, selection, anchor, toggle } = navigation;
  anchor.current = row.path;
  let selected = [row.path];
  if (additive)
    selected = selection.includes(row.path)
      ? selection.filter((path) => path !== row.path)
      : [...selection, row.path];
  if (!additive && row.directory) {
    toggle(row.path, true);
    return;
  }
  actions.tree(checkout, { focus: row.path, selected });
  if (!additive) {
    navigation.run(actions.open({ checkout, path: row.path }, { view: 'file', intent: 'preview' }));
  }
}
