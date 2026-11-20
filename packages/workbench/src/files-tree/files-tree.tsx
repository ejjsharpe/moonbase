import * as stylex from '@stylexjs/stylex';
import { Effect } from 'effect';
import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type Ref,
} from 'react';
import { useAtomValue } from '@effect/atom-react';
import { controls } from '@moonbase/ui/controls';
import { filesUI } from '@moonbase/ui/files';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { checkoutKey, type MutationAction } from '@moonbase/application/editor';
import { listFileCommands } from './file-commands.ts';
import type { FileClipboard } from './paste-plan.ts';
import { isInDropRegion, type MoveRecord } from './files-tree-drop.ts';
import { handleRowClick, handleTreeKeyDown, type TreeNavigation } from './files-tree-keyboard.ts';
import { FilesTreeMenu } from './files-tree-menu.tsx';
import { FilesTreeName } from './files-tree-name.tsx';
import { FilesTreeRow } from './files-tree-row.tsx';
import { findShownPath } from './files-tree-rows.ts';
import { rollUpGitStatus } from './files-tree-status.ts';
import { treeStyles } from './files-tree-styles.ts';
import { useDropTarget } from './use-drop-target.ts';
import { useEntryDrag } from './use-entry-drag.ts';
import { useFileDrop } from './use-file-drop.ts';
import { useFollowActiveFile, type FollowedFiles } from './use-follow-active-file.ts';
import { editLabels, startingName, useTreeEdit, type TreeCreateRequest } from './use-tree-edit.ts';
import { isNameField, useTreeFocus } from './use-tree-focus.ts';
import { useTreeMenu } from './use-tree-menu.ts';
import { useTreeVirtualizer } from './use-tree-virtualizer.ts';
import type { RunMutation } from '../mutation-runner.tsx';
import type { EditorActions } from '../editor-actions.ts';
import { useEditorTask } from '../use-editor-task.ts';

/** A checkout's files as a tree of `treeitem` rows, with its menu, name editing and drops. */
export function FilesTree({
  ref,
  actions,
  checkout,
  active,
  anchorReset,
  visible,
  follow,
  followed,
  dialogOpen,
  canRequestMutation,
  requestMutation,
  runMutation,
  undoLabel,
  onMoved,
  onUndo,
  createRequest,
  onCreateRequestTaken,
  mentionInChat,
  clipboard,
  onClipboard,
  onCancelCut,
  canPasteInto,
  onPaste,
}: {
  /** The tree element, where focus returns to the tree. */
  ref?: Ref<HTMLDivElement>;
  actions: EditorActions;
  checkout: CheckoutTarget;
  active: string;
  anchorReset: number;
  visible: boolean;
  /**
   * Whether the tree reveals each newly active file, as Follow Active File does while the tree is
   * shown: expanding its folders, then selecting it and scrolling it into view, without focus.
   */
  follow: boolean;
  /**
   * What each checkout's tree last followed, outliving the tree: while it can't follow, it
   * catches up once it can (shown again, or back from Changes) when the active file has changed.
   * A checkout first seen here keeps its restored tree rather than revealing at once.
   */
  followed: FollowedFiles;
  dialogOpen: boolean;
  canRequestMutation: (action: MutationAction) => boolean;
  requestMutation: (action: MutationAction, finalFocus: () => HTMLElement | false) => void;
  runMutation: RunMutation;
  /** What ⌘Z would undo, such as "Undo Rename", or undefined when there's nothing to undo. */
  undoLabel?: string;
  /** Records a move or rename made from the tree, for ⌘Z. */
  onMoved: (record: MoveRecord) => void;
  /**
   * Undoes the last move or rename; a replace prompt it raises returns focus to `finalFocus`.
   * Succeeds true once undone.
   */
  onUndo: (finalFocus: () => HTMLElement | false) => Effect.Effect<boolean>;
  createRequest: TreeCreateRequest | null;
  /** Called once the tree has started `createRequest`'s edit. */
  onCreateRequestTaken: () => void;
  /** Mentions files in the chat beside this checkout. */
  mentionInChat?: (checkout: CheckoutTarget, paths: string[]) => void;
  /** The workbench's file clipboard, whose cut entries in this checkout are dimmed. */
  clipboard: FileClipboard | null;
  /** Puts entries on the file clipboard to copy or move (⌘C, ⌘X). */
  onClipboard: (paths: string[], mode: FileClipboard['mode']) => void;
  /** Clears a pending cut in this checkout; true when there was one. */
  onCancelCut: () => boolean;
  /** Whether the file clipboard has something to paste into `folder`. */
  canPasteInto: (folder: string) => boolean;
  /** Pastes into `folder`, as ⌘V does into the focused one. */
  onPaste: (folder: string) => void;
}) {
  // The tree reads only its own checkout's pieces: typing in a buffer changes none of them.
  const { atoms } = actions,
    checkoutIdentity = checkoutKey(checkout);
  const tree = useAtomValue(atoms.views.checkoutTree(checkout.checkoutId))!,
    listings = useAtomValue(atoms.discovery.listings(checkoutIdentity)),
    dirty = useAtomValue(atoms.buffers.dirtyPaths(checkoutIdentity)),
    gitChanges = useAtomValue(atoms.discovery.git(checkoutIdentity))?.changes,
    disposed = useAtomValue(atoms.session.disposed),
    treeElement = useRef<HTMLDivElement>(null),
    anchor = useRef<string | null>(null),
    id = useId();
  // The tree's own work, such as an undo or a drop, ends with it: its checkout's tree is gone.
  const run = useEditorTask(actions);
  useImperativeHandle(ref, () => treeElement.current!, []);
  useLayoutEffect(() => {
    anchor.current = null;
  }, [anchorReset]);
  const setAnchor = (path: string | null) => {
    anchor.current = path;
  };
  const expanded = new Set(tree.expanded),
    selected = new Set(tree.selected),
    dirtyPaths = new Set(dirty);
  const focus = useTreeFocus({ actions, checkout, treeElement, visible });
  const { edit, rows, treeRows, editPath, startEdit, endEdit, commitEdit } = useTreeEdit({
    actions,
    checkout,
    listings,
    expanded,
    hideIgnored: !!tree.hideIgnoredFiles,
    setAnchor,
    focus,
    runMutation,
    onMoved,
    createRequest,
    onCreateRequestTaken,
  });
  const statuses = useMemo(() => rollUpGitStatus(gitChanges ?? []), [gitChanges]);
  const rowId = (path: string) => `${id}-${encodeURIComponent(path)}`;
  const rowsById = new Map(rows.map((row) => [rowId(row.path), row]));
  /** The listed row an event happened in, or undefined for the tree's empty area. */
  function findRowAt(target: EventTarget | null) {
    const element = target instanceof Element ? target.closest('[role="treeitem"]') : null;
    const row = element && rowsById.get(element.id);
    return row && !row.placeholder ? row : undefined;
  }
  const menu = useTreeMenu({
    actions,
    checkout,
    treeElement,
    setAnchor,
    selection: tree.selected,
    editPath,
    shown: (path) => rows.some((row) => row.path === path),
    returnTreeFocus: focus.returnTreeFocus,
    visible,
    dialogOpen,
    disposed,
  });
  const target = useDropTarget({ actions, checkout, treeElement, expanded });
  const dropInputs = {
    actions,
    checkout,
    editing: !!edit,
    dialogOpen,
    canRequestMutation,
    runMutation,
    setAnchor,
    focus,
    target,
    findRowAt,
  };
  const entryDrag = useEntryDrag({
    ...dropInputs,
    listings,
    selection: tree.selected,
    onMoved,
    closeMenu: menu.closeMenu,
  });
  const fileDrop = useFileDrop({ ...dropInputs, treeElement });
  const dropFolder = target.dropFolder;
  // Hiding ignored entries moves focus to the folder that still shows and drops hidden selections.
  const shownFocus = tree.hideIgnoredFiles
      ? findShownPath(listings, checkoutIdentity, tree.focus)
      : tree.focus,
    shownSelection = tree.hideIgnoredFiles
      ? tree.selected.filter((path) => findShownPath(listings, checkoutIdentity, path) === path)
      : tree.selected,
    hiddenSelection =
      shownFocus !== tree.focus || shownSelection.length !== tree.selected.length
        ? JSON.stringify([shownFocus, shownSelection])
        : null;
  useEffect(() => {
    if (hiddenSelection === null) return;
    const [focus, selected] = JSON.parse(hiddenSelection) as [string, string[]];
    anchor.current = null;
    actions.tree(checkout, { focus, selected });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Move each hidden selection once.
  }, [hiddenSelection]);
  useFollowActiveFile({
    actions,
    checkout,
    treeElement,
    setAnchor,
    follow,
    followed,
    active,
    dialogOpen,
    busy: !!edit || !!menu.menu || dropFolder !== null || !!entryDrag.dragged.length,
  });
  const virtualizer = useTreeVirtualizer({
    treeElement,
    rows,
    focus: tree.focus,
    editPath,
    editId: edit?.id,
    pinnedPaths: entryDrag.dragged,
    initialScroll: tree.scroll,
    onScrollRest: (scroll) => actions.tree(checkout, { scroll }),
  });
  const commandContext = {
    actions,
    checkout,
    listings,
    canRequestMutation,
    requestMutation,
    startEdit,
    returnTreeFocus: focus.returnTreeFocus,
    run,
    mentionInChat,
    putOnClipboard: onClipboard,
    canPasteInto,
    pasteInto: onPaste,
  };
  const cutPaths =
    clipboard?.mode === 'cut' && checkoutKey(clipboard.checkout) === checkoutIdentity
      ? clipboard.paths
      : [];
  function toggle(path: string, select = false) {
    const wasExpanded = expanded.has(path);
    actions.tree(checkout, {
      ...(select ? { focus: path, selected: [path] } : {}),
      expanded: wasExpanded
        ? tree.expanded.filter((value) => value !== path)
        : [...tree.expanded, path],
    });
    if (!wasExpanded) actions.start(actions.list(checkout, path));
  }
  const treeFocusIndex = Math.max(
    0,
    treeRows.findIndex((row) => row.path === tree.focus),
  );
  const navigation: TreeNavigation = {
    actions,
    run,
    checkout,
    rows: treeRows,
    focusIndex: treeFocusIndex,
    selection: tree.selected,
    expanded,
    anchor,
    toggle,
    openMenuBelow(path) {
      const rect = document.getElementById(rowId(path))!.getBoundingClientRect();
      menu.openMenu(path, rect.left, rect.bottom);
    },
    commandsFor: (paths) => listFileCommands(commandContext, paths),
    undo() {
      if (!undoLabel) return;
      run(
        Effect.tap(onUndo(focus.returnTreeFocus), (undone) =>
          Effect.sync(() => {
            if (!undone) return;
            anchor.current = null;
            if (focus.focusStayed()) focus.refocusTree();
          }),
        ),
      );
    },
    cancelCut: onCancelCut,
  };
  const root = listings[JSON.stringify([checkoutIdentity, ''])];
  return (
    <>
      {Object.entries(listings).map(([key, listing]) =>
        listing.error || listing.partial ? (
          <p key={key} role="status" {...stylex.props(controls.status)}>
            {listing.error ?? 'File listing is partial. Refresh to retry.'}
          </p>
        ) : null,
      )}
      <div
        ref={treeElement}
        role="tree"
        aria-label="Files"
        aria-multiselectable="true"
        tabIndex={0}
        aria-busy={!root}
        aria-activedescendant={
          treeRows[treeFocusIndex] ? rowId(treeRows[treeFocusIndex].path) : undefined
        }
        data-drop-target={dropFolder === '' || undefined}
        {...stylex.props(
          filesUI.tree,
          dropFolder === '' && filesUI.dropRoot,
          stylex.defaultMarker(),
        )}
        onDragStart={entryDrag.onDragStart}
        onDragEnd={entryDrag.onDragEnd}
        onDragEnter={(event) => {
          fileDrop.onDragEnter(event);
          entryDrag.onDragEnter(event);
        }}
        onDragOver={(event) => {
          fileDrop.onDragOver(event);
          entryDrag.onDragOver(event);
        }}
        onDragLeave={(event) => {
          fileDrop.onDragLeave(event);
          entryDrag.onDragLeave(event);
        }}
        onDrop={(event) => {
          fileDrop.onDrop(event);
          entryDrag.onDrop(event);
        }}
        onPointerDown={focus.onPointerDown}
        onFocus={focus.onFocus}
        onScroll={(event) => {
          if (event.target === event.currentTarget)
            menu.closeForScroll(event.currentTarget.scrollTop);
        }}
        onKeyDown={(event) => {
          if (!isNameField(event.target)) handleTreeKeyDown(event, navigation);
        }}>
        <div {...stylex.props(treeStyles.extent(virtualizer.getTotalSize()))}>
          {virtualizer.getVirtualItems().map(({ index }) => {
            const row = rows[index],
              editing = edit && row.path === editPath ? edit : null;
            let label: string | undefined;
            if (row.placeholder && edit?.kind === 'duplicate') label = `Copy of ${edit.path}`;
            else if (row.placeholder) label = row.directory ? 'New folder' : 'New file';
            return (
              <FilesTreeRow
                key={row.path}
                id={rowId(row.path)}
                row={row}
                index={index}
                expanded={expanded.has(row.path)}
                selected={!row.placeholder && selected.has(row.path)}
                focused={!row.placeholder && tree.focus === row.path}
                active={row.path === active}
                dirty={dirtyPaths.has(row.path)}
                cut={
                  !row.placeholder &&
                  cutPaths.some((path) => row.path === path || row.path.startsWith(path + '/'))
                }
                status={statuses.get(row.path)}
                label={label}
                draggable={!edit && !dialogOpen && !row.placeholder}
                dropTarget={isInDropRegion(row.path, dropFolder)}
                editor={
                  editing && (
                    <FilesTreeName
                      key={editing.id}
                      actions={actions}
                      label={editLabels[editing.kind]}
                      initial={startingName(editing)}
                      directory={row.directory}
                      onCommit={(name, how, next) => commitEdit(editing, name, how, next)}
                      onCancel={() => endEdit(editing, undefined, true)}
                    />
                  )
                }
                onOpenMenu={menu.openMenu}
                onSelect={(row, additive) => {
                  if (row.path === editPath) return;
                  treeElement.current?.focus();
                  handleRowClick(navigation, row, additive);
                }}
                onOpen={(path) => {
                  if (path === editPath) return;
                  run(actions.open({ checkout, path }, { view: 'file', intent: 'keep' }));
                }}
              />
            );
          })}
        </div>
        {root && !rows.length && (
          <p {...stylex.props(controls.status)}>
            {root.entries.length ? 'No visible entries' : 'Empty folder'}
          </p>
        )}
      </div>
      <FilesTreeMenu
        menu={menu}
        commands={
          menu.menu ? listFileCommands(commandContext, menu.menu.paths, menu.menu.path) : []
        }
        refocusTree={focus.refocusTree}
      />
    </>
  );
}
