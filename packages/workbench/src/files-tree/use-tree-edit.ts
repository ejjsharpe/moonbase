import { useEffect, useRef, useState } from 'react';
import { Effect } from 'effect';
import { getParentPath, getPathName } from '@moonbase/contracts/paths';
import type { CheckoutTarget, DirectoryListing } from '@moonbase/contracts/workspace';
import { checkoutKey, type MutationRunResult } from '@moonbase/application/editor';
import { editMutations, type TreeEditKind } from './file-commands.ts';
import { copyName } from './paste-plan.ts';
import type { NameCommit } from './files-tree-name.tsx';
import {
  isListedDirectory,
  listVisibleRows,
  placeholderPath,
  type RowPlaceholder,
} from './files-tree-rows.ts';
import { listFoldersToExpand, type MoveRecord } from './files-tree-drop.ts';
import { canRefocus, type TreeFocus } from './use-tree-focus.ts';
import type { RunMutation } from '../mutation-runner.tsx';
import type { EditorActions } from '../editor-actions.ts';
import type { WorkbenchServices } from '../workbench-editor.ts';

/**
 * A name being typed in the tree: renaming or duplicating `path`, or creating in folder `path`.
 * `focus` and `selected` are the tree's as the edit started.
 */
export type TreeEdit = {
  kind: TreeEditKind;
  path: string;
  id: number;
  focus: string;
  selected: string[];
};
/** A request from outside the tree, such as the explorer's "…" menu, to create in `parent`. */
export type TreeCreateRequest = {
  checkout: CheckoutTarget;
  kind: 'create-file' | 'create-directory';
  parent: string;
  id: number;
};

/** The name a field starts with: an entry's own, its copy's, or none for a new one. */
export function startingName(edit: TreeEdit) {
  if (edit.kind === 'rename') return getPathName(edit.path);
  return edit.kind === 'duplicate' ? copyName(getPathName(edit.path), false) : '';
}
export const editLabels: Record<TreeEditKind, string> = {
  rename: 'Rename',
  duplicate: 'Duplicate as',
  'create-file': 'New file name',
  'create-directory': 'New folder name',
};
const isCreate = (edit: TreeEdit) =>
  edit.kind === 'create-file' || edit.kind === 'create-directory';

/**
 * Typing a name in a files tree's row: renaming, duplicating, or creating a file or folder, from
 * the tree's commands or a `createRequest` from outside it. `rows` are the tree's as shown, with
 * the placeholder row a new entry's name is typed in, `treeRows` the same without it, and
 * `editPath` the row showing the field.
 */
export function useTreeEdit({
  actions,
  checkout,
  listings,
  expanded,
  hideIgnored,
  setAnchor,
  focus,
  runMutation,
  onMoved,
  createRequest,
  onCreateRequestTaken,
}: {
  actions: EditorActions;
  checkout: CheckoutTarget;
  listings: Readonly<Record<string, DirectoryListing>>;
  expanded: ReadonlySet<string>;
  hideIgnored: boolean;
  /** Sets the entry a Shift-selection extends from, or clears it. */
  setAnchor: (path: string | null) => void;
  focus: TreeFocus;
  runMutation: RunMutation;
  onMoved: (record: MoveRecord) => void;
  createRequest: TreeCreateRequest | null;
  onCreateRequestTaken: () => void;
}) {
  const [edit, setEdit] = useState<TreeEdit | null>(null),
    editIds = useRef(0),
    committing = useRef(false);
  const checkoutIdentity = checkoutKey(checkout);
  const editParent = edit && (isCreate(edit) ? edit.path : getParentPath(edit.path));
  let placeholder: RowPlaceholder | undefined;
  if (edit && edit.kind !== 'rename')
    placeholder = {
      parent: editParent!,
      directory: edit.kind === 'create-directory',
      ...(edit.kind === 'duplicate' ? { after: edit.path } : {}),
    };
  const editPath = edit && (edit.kind === 'rename' ? edit.path : placeholderPath(editParent!));
  // Keyboard navigation and selection skip the placeholder.
  const rows = listVisibleRows(listings, checkoutIdentity, expanded, placeholder, hideIgnored),
    treeRows = placeholder ? rows.filter((row) => !row.placeholder) : rows;
  // Renaming or duplicating an entry that has gone, such as one moved elsewhere, ends the edit.
  const sourceGone =
    !!edit &&
    !isCreate(edit) &&
    !treeRows.some((row) => row.path === edit.path) &&
    !committing.current;
  useEffect(() => {
    if (sourceGone) setEdit(null);
  }, [sourceGone]);
  /** Starts typing a name: expands a folder created in, and selects an entry renamed. */
  function startEdit(kind: TreeEditKind, path: string) {
    const current = actions.read(actions.atoms.views.checkoutTree(checkout.checkoutId));
    if (!current) return;
    if (kind === 'create-file' || kind === 'create-directory') {
      const opening = listFoldersToExpand(path).filter(
        (folder) => !current.expanded.includes(folder),
      );
      if (opening.length) actions.tree(checkout, { expanded: [...current.expanded, ...opening] });
      for (const folder of opening) actions.start(actions.list(checkout, folder));
    } else {
      setAnchor(path);
      actions.tree(checkout, { focus: path, selected: [path] });
    }
    const started = actions.read(actions.atoms.views.checkoutTree(checkout.checkoutId))!;
    setEdit({
      kind,
      path,
      id: ++editIds.current,
      focus: started.focus,
      selected: [...started.selected],
    });
  }
  /**
   * Ends an edit. Its result becomes the tree's focus and selection unless the user has selected
   * something else meanwhile, and the tree takes focus back when asked and focus is still the
   * edit's to place.
   */
  function endEdit(ended: TreeEdit, focusPath: string | undefined, focusTree: boolean) {
    setEdit((current) => (current?.id === ended.id ? null : current));
    const now = actions.read(actions.atoms.views.checkoutTree(checkout.checkoutId));
    const untouched =
      !!now &&
      now.focus === ended.focus &&
      now.selected.length === ended.selected.length &&
      now.selected.every((path, index) => path === ended.selected[index]);
    if (focusPath && untouched) {
      setAnchor(focusPath);
      actions.tree(checkout, { focus: focusPath, selected: [focusPath] });
    }
    if (focusTree && focus.focusStayed()) focus.refocusTree();
  }
  /**
   * Commits a typed name: an error to show beside the field after Enter, '' to keep editing after
   * a declined replacement, or null once the edit has ended. Blur reports errors and ends it; a
   * replace prompt it raises returns focus to `next`, where focus went, or else to the tree.
   */
  const commitEdit = (
    current: TreeEdit,
    name: string,
    how: NameCommit,
    next: Element | null,
  ): Effect.Effect<string | null, unknown, WorkbenchServices> =>
    Effect.gen(function* () {
      const enter = how === 'enter',
        create = isCreate(current),
        parent = create ? current.path : getParentPath(current.path);
      const end = (focusPath?: string) => {
        endEdit(current, focusPath, enter);
        return null;
      };
      const invalid = (message: string) => {
        if (enter) return message;
        actions.report(message);
        return end();
      };
      // Names are taken as typed, spaces included, but one of only spaces is no name.
      if (!name.trim()) return current.kind === 'rename' && enter ? 'Enter a name.' : end();
      if (name.includes('/')) return invalid('A name can’t contain “/”.');
      if (current.kind === 'rename' && name === getPathName(current.path)) return end(current.path);
      const destination = parent ? `${parent}/${name}` : name;
      const directory = isListedDirectory(listings, checkoutIdentity, current.path);
      // A failure is shown beside the field while it waits for one; once its wait is interrupted
      // (the field gone), the editor's alerts show it instead.
      let error = '',
        fieldGone = false;
      committing.current = true;
      // A rename is Undo's to record, even if the tree goes before it finishes.
      const settled = (result: MutationRunResult) => {
        if (result.completed && current.kind === 'rename')
          onMoved({ kind: 'rename', moves: [{ from: current.path, to: destination, directory }] });
      };
      const { completed } = yield* runMutation(
        { checkout, kind: editMutations[current.kind], paths: create ? [] : [current.path] },
        destination,
        enter
          ? {
              inlineError: (message) => {
                if (fieldGone) actions.report(message);
                else error = message;
              },
              settled,
            }
          : { finalFocus: () => (canRefocus(next) ? next : focus.returnTreeFocus()), settled },
      ).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            fieldGone = true;
            if (error) actions.report(error);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            committing.current = false;
          }),
        ),
      );
      if (completed) {
        if (current.kind === 'create-file')
          actions.start(
            actions.open({ checkout, path: destination }, { view: 'file', intent: 'keep' }),
          );
        return end(destination);
      }
      if (error) return error;
      return enter ? '' : end();
    });
  useEffect(() => {
    if (!createRequest) return;
    onCreateRequestTaken();
    if (checkoutKey(createRequest.checkout) === checkoutIdentity)
      startEdit(createRequest.kind, createRequest.parent);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Start each request once.
  }, [createRequest?.id]);
  return {
    edit,
    rows,
    treeRows,
    editPath,
    startEdit,
    endEdit,
    commitEdit,
  };
}
