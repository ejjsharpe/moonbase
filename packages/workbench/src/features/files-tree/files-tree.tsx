import { getParentPath, getPathName, joinPath } from '@moonbase/contracts/paths';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { styles } from '../../components/styles.ts';
import { Icon } from '@moonbase/ui/icons';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { filesUI } from '@moonbase/ui/files';
import { overlays } from '@moonbase/ui/overlays';
import { ContextMenu } from '@base-ui/react/context-menu';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import {
  checkoutKey,
  readOwn,
  type EditorController,
  type EditorSnapshot,
  type MutationAction,
} from '@moonbase/application/editor';
import {
  ariaKeys,
  formatKeys,
  editMutations,
  listFileCommands,
  type TreeEditKind,
} from '../../lib/file-commands.ts';
import { handleRowClick, handleTreeKeyDown, type TreeNavigation } from './files-tree-keyboard.ts';
import { FilesTreeName, type NameCommit } from './files-tree-name.tsx';
import { FilesTreeRow } from './files-tree-row.tsx';
import {
  findShownPath,
  listVisibleRows,
  placeholderPath,
  rowHeight,
  selectMountedIndexes,
  type RowPlaceholder,
  type VisibleRow,
} from './files-tree-rows.ts';
import { rollUpGitStatus } from './files-tree-status.ts';
import {
  entriesType,
  findCollidingName,
  findDropFolder,
  getDropDestination,
  isInDropRegion,
  isSameDrag,
  listDroppedPaths,
  listFoldersToExpand,
  listTransferred,
  maxDraggedEntries,
  planDrop,
  selectDraggedPaths,
  takeFileDrop,
  type MoveRecord,
  type TreeDrag,
} from './files-tree-drop.ts';
import { selectEntries } from './move-undo.ts';
import { copyName, type FileClipboard } from './file-clipboard.ts';
import type { RunMutation } from '../../components/mutation-runner.tsx';

/**
 * A name being typed in the tree: renaming or duplicating `path`, or creating in folder `path`.
 * `focus` and `selected` are the tree's as the edit started.
 */
type TreeEdit = {
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
/**
 * Per checkout key, the active file its tree last followed (or left alone while the user was in
 * it), or null when the next chance to follow should reveal it whatever it is.
 */
export type FollowedFiles = Map<string, string | null>;

/**
 * The drag a files tree in this document started, until it ends. A tree accepts only its own:
 * DataTransfer contents can't be read until the drop, and a drag from another window or editor
 * is refused.
 */
let activeDrag: TreeDrag | null = null;

/** Shows how many entries are dragged under the pointer instead of the grabbed row alone. */
function setCountImage(dataTransfer: DataTransfer, count: number) {
  const badge = document.createElement('div');
  const { className, style } = stylex.props(filesUI.dragImage);
  if (className) badge.className = className;
  if (style) Object.assign(badge.style, style);
  badge.textContent = String(count);
  document.body.append(badge);
  dataTransfer.setDragImage(badge, -8, -8);
  // The browser captures the image as the drag starts.
  setTimeout(() => badge.remove());
}

/** Whether a drag carries files from the OS, such as Finder's, rather than the tree's entries. */
const isFileDrag = (dataTransfer: DataTransfer) =>
  dataTransfer.types.includes('Files') && !dataTransfer.types.includes(entriesType);
const isNameField = (target: EventTarget) =>
  target instanceof HTMLElement && target.tagName === 'INPUT';
/** Whether an element that took focus can take it again. */
const canRefocus = (element: Element | null): element is HTMLElement =>
  element instanceof HTMLElement &&
  element.isConnected &&
  element.getClientRects().length > 0 &&
  !element.matches(':disabled') &&
  !element.closest('[inert]');
/** The name a field starts with: an entry's own, its copy's, or none for a new one. */
function startingName(edit: TreeEdit) {
  if (edit.kind === 'rename') return getPathName(edit.path);
  return edit.kind === 'duplicate' ? copyName(getPathName(edit.path), false) : '';
}
const editLabels: Record<TreeEditKind, string> = {
  rename: 'Rename',
  duplicate: 'Duplicate as',
  'create-file': 'New file name',
  'create-directory': 'New folder name',
};

export function FilesTree({
  controller,
  state,
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
  copyPaths,
  revealPath,
  mentionInChat,
  selectDroppedImports,
  clipboard,
  onClipboard,
  onCancelCut,
  canPasteInto,
  onPaste,
}: {
  controller: EditorController;
  state: EditorSnapshot;
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
   * Resolves true once undone.
   */
  onUndo: (finalFocus: () => HTMLElement | false) => Promise<boolean>;
  createRequest: TreeCreateRequest | null;
  /** Called once the tree has started `createRequest`'s edit. */
  onCreateRequestTaken: () => void;
  /** Copies a checkout's paths to the clipboard, joined by newlines: absolute, or as `relative`. */
  copyPaths?: (checkout: CheckoutTarget, paths: string[], relative: boolean) => Promise<void>;
  /** Shows a checkout's file or folder in the OS file manager. */
  revealPath?: (checkout: CheckoutTarget, path: string) => Promise<void>;
  /** Mentions files in the chat beside this checkout. */
  mentionInChat?: (checkout: CheckoutTarget, paths: string[]) => void;
  /**
   * Approves files dropped from the OS for import into a checkout, one opaque reference per file
   * in order. Without it, such drops pass through to the app.
   */
  selectDroppedImports?: (checkout: CheckoutTarget, files: File[]) => Promise<string[]>;
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
  const tree = readOwn(state.recovery.views, checkout.checkoutId)!.tree,
    treeElement = useRef<HTMLDivElement>(null),
    anchor = useRef<string | null>(null),
    id = useId();
  const [menu, setMenu] = useState<{
    checkout: CheckoutTarget;
    paths: string[];
    path: string;
    point: DOMRect;
    scroll: number;
  } | null>(null);
  const restoreMenuFocus = useRef(true),
    visibility = useRef(visible);
  useLayoutEffect(() => {
    visibility.current = visible;
    if (dialogOpen) restoreMenuFocus.current = false;
  }, [visible, dialogOpen]);
  const checkoutIdentity = checkoutKey(checkout),
    expanded = new Set(tree.expanded),
    selected = new Set(tree.selected),
    dirtyPaths = new Set(
      state.buffers
        .filter(
          (buffer) =>
            checkoutKey(buffer.target.checkout) === checkoutIdentity &&
            buffer.text !== buffer.disk.text,
        )
        .map((buffer) => buffer.target.path),
    );
  useLayoutEffect(() => {
    anchor.current = null;
  }, [anchorReset]);
  const [geometry, setGeometry] = useState({ top: tree.scroll, height: 500 });
  const [edit, setEdit] = useState<TreeEdit | null>(null),
    editIds = useRef(0),
    committing = useRef(false),
    mounted = useRef(true),
    // What a drop's import, once approved, finds the tree doing now.
    latest = useRef({ edit, dialogOpen, checkoutIdentity }),
    importingDrop = useRef(false);
  useLayoutEffect(() => {
    latest.current = { edit, dialogOpen, checkoutIdentity };
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A drag from this tree: the rows kept mounted for it, and where it would drop.
  const [dragged, setDragged] = useState<string[]>([]),
    [dropFolder, setDropFolder] = useState<string | null>(null),
    ownDrag = useRef<TreeDrag | null>(null),
    hoverExpansion = useRef<{ path: string; timer: number } | null>(null),
    dragLeave = useRef<number | undefined>(undefined),
    endDrag = useRef(() => {}),
    // Whether the primary button is down on the tree, and how it's let go.
    pressing = useRef(false),
    releasePressRef = useRef(() => {});
  const creating = edit?.kind === 'create-file' || edit?.kind === 'create-directory';
  const editParent = edit && (creating ? edit.path : getParentPath(edit.path));
  let placeholder: RowPlaceholder | undefined;
  if (edit && edit.kind !== 'rename')
    placeholder = {
      parent: editParent!,
      directory: edit.kind === 'create-directory',
      ...(edit.kind === 'duplicate' ? { after: edit.path } : {}),
    };
  const editPath = edit && (edit.kind === 'rename' ? edit.path : placeholderPath(editParent!));
  // Rows as shown, with any placeholder; keyboard navigation and selection skip the placeholder.
  const rows = listVisibleRows(
      state.listings,
      checkoutIdentity,
      expanded,
      placeholder,
      !!tree.hideIgnoredFiles,
    ),
    treeRows = placeholder ? rows.filter((row) => !row.placeholder) : rows;
  const gitChanges = state.git[checkoutIdentity]?.changes,
    statuses = useMemo(() => rollUpGitStatus(gitChanges ?? []), [gitChanges]);
  const rowId = (path: string) => `${id}-${encodeURIComponent(path)}`;
  const menuAvailable =
    !!menu &&
    visible &&
    !dialogOpen &&
    !state.disposed &&
    checkoutKey(menu.checkout) === checkoutIdentity &&
    rows.some((row) => row.path === menu.path);
  useLayoutEffect(() => {
    if (!menuAvailable) return;
    const ownerDocument = treeElement.current!.ownerDocument;
    function dismissForDialog(event: FocusEvent) {
      if (!(event.target instanceof Element) || !event.target.closest('[role="dialog"]')) return;
      restoreMenuFocus.current = false;
      setMenu(null);
    }
    ownerDocument.addEventListener('focusin', dismissForDialog);
    return () => ownerDocument.removeEventListener('focusin', dismissForDialog);
  }, [menuAvailable]);
  useEffect(() => {
    if (menu && !menuAvailable) {
      setMenu(null);
    }
  }, [menu, menuAvailable]);
  function returnTreeFocus() {
    const element = treeElement.current,
      snapshot = controller.getSnapshot(),
      recovery = snapshot.recovery;
    return visibility.current &&
      !snapshot.disposed &&
      element?.isConnected &&
      element.getClientRects().length &&
      recovery.openCheckoutIds.includes(checkout.checkoutId) &&
      recovery.checkouts.some((target) => checkoutKey(target) === checkoutIdentity)
      ? element
      : false;
  }
  function openMenu(path: string, x: number, y: number) {
    if (path === editPath) return;
    const paths = selected.has(path) ? [...tree.selected] : [path];
    if (!selected.has(path)) anchor.current = path;
    restoreMenuFocus.current = true;
    setMenu({
      checkout: { ...checkout },
      paths,
      path,
      point: DOMRect.fromRect({ x, y }),
      scroll: treeElement.current!.scrollTop,
    });
    controller.tree(checkout, { focus: path, selected: paths });
  }
  /** Starts typing a name: expands a folder created in, and selects an entry renamed. */
  function startEdit(kind: TreeEditKind, path: string) {
    const current = readOwn(controller.getSnapshot().recovery.views, checkout.checkoutId)?.tree;
    if (!current) return;
    if (kind === 'create-file' || kind === 'create-directory') {
      const opening = listFoldersToExpand(path).filter(
        (folder) => !current.expanded.includes(folder),
      );
      if (opening.length)
        controller.tree(checkout, { expanded: [...current.expanded, ...opening] });
      for (const folder of opening) void controller.list(checkout, folder).catch(controller.report);
    } else {
      anchor.current = path;
      controller.tree(checkout, { focus: path, selected: [path] });
    }
    const started = readOwn(controller.getSnapshot().recovery.views, checkout.checkoutId)!.tree;
    setEdit({
      kind,
      path,
      id: ++editIds.current,
      focus: started.focus,
      selected: [...started.selected],
    });
  }
  /** Whether focus is still the edit's to place: in the tree, in a prompt, or nowhere. */
  function focusStayed() {
    const element = treeElement.current,
      focused = element?.ownerDocument.activeElement;
    return (
      !focused ||
      focused === element?.ownerDocument.body ||
      !!element?.contains(focused) ||
      !!focused.closest('[role="dialog"]')
    );
  }
  /**
   * Ends an edit. Its result becomes the tree's focus and selection unless the user has selected
   * something else meanwhile, and the tree takes focus back when asked and focus is still the
   * edit's to place.
   */
  function endEdit(ended: TreeEdit, focusPath: string | undefined, focusTree: boolean) {
    setEdit((current) => (current?.id === ended.id ? null : current));
    if (!mounted.current) return;
    const now = readOwn(controller.getSnapshot().recovery.views, checkout.checkoutId)?.tree;
    const untouched =
      !!now &&
      now.focus === ended.focus &&
      now.selected.length === ended.selected.length &&
      now.selected.every((path, index) => path === ended.selected[index]);
    if (focusPath && untouched)
      try {
        anchor.current = focusPath;
        controller.tree(checkout, { focus: focusPath, selected: [focusPath] });
      } catch (error) {
        controller.report(error);
      }
    if (focusTree && focusStayed()) {
      const element = returnTreeFocus();
      if (element) element.focus();
    }
  }
  /**
   * Commits a typed name: an error to show beside the field after Enter, '' to keep editing after
   * a declined replacement, or null once the edit has ended. Blur reports errors and ends it; a
   * replace prompt it raises returns focus to `next`, where focus went, or else to the tree.
   */
  async function commitEdit(
    current: TreeEdit,
    name: string,
    how: NameCommit,
    next: Element | null,
  ) {
    const enter = how === 'enter',
      create = current.kind === 'create-file' || current.kind === 'create-directory',
      parent = create ? current.path : getParentPath(current.path);
    const end = (focusPath?: string) => {
      endEdit(current, focusPath, enter);
      return null;
    };
    const invalid = (message: string) => {
      if (enter) return message;
      controller.report(message);
      return end();
    };
    // Names are taken as typed, spaces included, but one of only spaces is no name.
    if (!name.trim()) return current.kind === 'rename' && enter ? 'Enter a name.' : end();
    if (name.includes('/')) return invalid('A name can’t contain “/”.');
    if (current.kind === 'rename' && name === getPathName(current.path)) return end(current.path);
    const destination = parent ? `${parent}/${name}` : name;
    const directory = isDirectory(current.path);
    let error = '';
    committing.current = true;
    const { completed } = await runMutation(
      { checkout, kind: editMutations[current.kind], paths: create ? [] : [current.path] },
      destination,
      enter
        ? {
            inlineError: (message) => {
              error = message;
            },
          }
        : { finalFocus: () => (canRefocus(next) ? next : returnTreeFocus()) },
    ).finally(() => {
      committing.current = false;
    });
    if (completed) {
      if (current.kind === 'rename')
        onMoved({ kind: 'rename', moves: [{ from: current.path, to: destination, directory }] });
      if (current.kind === 'create-file' && mounted.current)
        void controller
          .open({ checkout, path: destination }, { view: 'file', intent: 'keep' })
          .catch(controller.report);
      return end(destination);
    }
    if (error) return error;
    return enter ? '' : end();
  }
  // Hiding ignored entries moves focus to the folder that still shows and drops hidden selections.
  const shownFocus = tree.hideIgnoredFiles
      ? findShownPath(state.listings, checkoutIdentity, tree.focus)
      : tree.focus,
    shownSelection = tree.hideIgnoredFiles
      ? tree.selected.filter(
          (path) => findShownPath(state.listings, checkoutIdentity, path) === path,
        )
      : tree.selected,
    hiddenSelection =
      shownFocus !== tree.focus || shownSelection.length !== tree.selected.length
        ? JSON.stringify([shownFocus, shownSelection])
        : null;
  useEffect(() => {
    if (hiddenSelection === null) return;
    const [focus, selected] = JSON.parse(hiddenSelection) as [string, string[]];
    anchor.current = null;
    try {
      controller.tree(checkout, { focus, selected });
    } catch (error) {
      controller.report(error);
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Move each hidden selection once.
  }, [hiddenSelection]);
  // What can stop the tree following the active file, as of the latest render.
  const followState = useRef({
    follow,
    active,
    edit,
    menu,
    dialogOpen,
    dropFolder,
    dragging: !!dragged.length,
  });
  useLayoutEffect(() => {
    followState.current = {
      follow,
      active,
      edit,
      menu,
      dialogOpen,
      dropFolder,
      dragging: !!dragged.length,
    };
  });
  useEffect(() => {
    // A checkout first seen keeps its restored tree; later, a file made active while the tree
    // couldn't follow (hidden, unmounted for Changes, or behind a dialog) is revealed once it can.
    if (!followed.has(checkoutIdentity)) followed.set(checkoutIdentity, active);
    const previous = followed.get(checkoutIdentity)!;
    if (!follow || dialogOpen || !active || previous === active) return;
    followed.set(checkoutIdentity, active);
    const path = active;
    // The tree follows only while shown and left alone: not while the user is in it, typing a
    // name, dragging, in its menu or a dialog, and only while `path` is still the active file.
    const canFollow = () => {
      const now = followState.current,
        element = treeElement.current;
      return (
        mounted.current &&
        now.follow &&
        now.active === path &&
        !now.edit &&
        !now.menu &&
        !now.dialogOpen &&
        now.dropFolder === null &&
        !now.dragging &&
        !activeDrag &&
        !!element &&
        !element.contains(element.ownerDocument.activeElement)
      );
    };
    // While the user is in the tree it stays where they left it, even once they leave.
    if (!canFollow()) return;
    let started = false;
    // Rapid switches settle on the last file before anything is listed for it.
    const timer = setTimeout(() => {
      started = true;
      if (!canFollow()) return;
      // Hidden ignored files stay hidden rather than turning Hide Ignored Files off, and a follow
      // the user didn't ask for reports nothing.
      controller
        .reveal({ checkout, path }, { ignored: 'skip', current: canFollow, quiet: true })
        .then(
          (revealed) => {
            if (revealed) anchor.current = null;
          },
          () => {
            // Following is best effort: a file that has gone simply isn't revealed.
          },
        );
    }, 50);
    return () => {
      clearTimeout(timer);
      // Stopped before it began, such as by hiding the tree, it is still to catch up on.
      if (!started && followed.get(checkoutIdentity) === path)
        followed.set(checkoutIdentity, previous);
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Follow each active file, catching up when following resumes.
  }, [active, follow, dialogOpen]);
  useEffect(() => {
    if (!createRequest) return;
    onCreateRequestTaken();
    if (checkoutKey(createRequest.checkout) === checkoutIdentity)
      startEdit(createRequest.kind, createRequest.parent);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Start each request once.
  }, [createRequest?.id]);
  const commandContext = {
    controller,
    checkout,
    listings: state.listings,
    canRequestMutation,
    requestMutation,
    startEdit,
    returnTreeFocus,
    copyPaths,
    revealPath,
    mentionInChat,
    putOnClipboard: onClipboard,
    canPasteInto,
    pasteInto: onPaste,
  };
  const cutPaths =
    clipboard?.mode === 'cut' && checkoutKey(clipboard.checkout) === checkoutIdentity
      ? clipboard.paths
      : [];
  useEffect(() => {
    const element = treeElement.current;
    if (!element) return;
    element.scrollTop = tree.scroll;
    const observer = new ResizeObserver(() =>
      setGeometry((old) => ({ ...old, height: element.clientHeight })),
    );
    observer.observe(element);
    return () => observer.disconnect();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Restore scroll on checkout changes; ordinary scroll updates must not recreate the observer.
  }, [checkoutIdentity]);
  const focusIndex = Math.max(
      0,
      rows.findIndex((row) => row.path === tree.focus),
    ),
    treeFocusIndex = Math.max(
      0,
      treeRows.findIndex((row) => row.path === tree.focus),
    ),
    editIndex = editPath === null ? -1 : rows.findIndex((row) => row.path === editPath);
  function scrollToRow(index: number) {
    const element = treeElement.current;
    if (!element || index < 0 || index >= rows.length) return;
    const top = index * rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + element.clientHeight)
      element.scrollTop = top + rowHeight - element.clientHeight;
  }
  useEffect(() => {
    scrollToRow(focusIndex);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Follow focus, not every render.
  }, [tree.focus, focusIndex, rows.length]);
  // Renaming or duplicating an entry that has gone, such as one moved elsewhere, ends the edit.
  const sourceGone =
    !!edit && !creating && !treeRows.some((row) => row.path === edit.path) && !committing.current;
  useEffect(() => {
    if (sourceGone) setEdit(null);
  }, [sourceGone]);
  useEffect(() => {
    scrollToRow(editIndex);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Bring each new edit into view once.
  }, [edit?.id, editIndex < 0]);
  function toggle(path: string, select = false) {
    const wasExpanded = expanded.has(path);
    controller.tree(checkout, {
      ...(select ? { focus: path, selected: [path] } : {}),
      expanded: wasExpanded
        ? tree.expanded.filter((value) => value !== path)
        : [...tree.expanded, path],
    });
    if (!wasExpanded) void controller.list(checkout, path).catch(controller.report);
  }
  /** Whether a listed entry of this checkout is a folder. */
  function isDirectory(path: string) {
    const listing = state.listings[JSON.stringify([checkoutIdentity, getParentPath(path)])];
    return !!listing?.entries.find((entry) => entry.path === path)?.directory;
  }
  const rowsById = new Map(rows.map((row) => [rowId(row.path), row]));
  /** The listed row an event happened in, or undefined for the tree's empty area. */
  function findRowAt(target: EventTarget | null) {
    const element = target instanceof Element ? target.closest('[role="treeitem"]') : null;
    const row = element && rowsById.get(element.id);
    return row && !row.placeholder ? row : undefined;
  }
  /** Where entries dragged over the tree would land, or null when no drop is offered. */
  function planDropInto(folder: string) {
    if (edit || dialogOpen) return null;
    const paths = planDrop(activeDrag, {
      source: controller.instanceId,
      checkout: checkoutIdentity,
      folder,
    });
    return paths && canRequestMutation({ checkout, kind: 'move', paths }) ? paths : null;
  }
  /** Expands a folder that a drag has hovered over for a moment. */
  function expandForDrag(path: string) {
    try {
      const current = readOwn(controller.getSnapshot().recovery.views, checkout.checkoutId)?.tree;
      if (!current || current.expanded.includes(path)) return;
      controller.tree(checkout, { expanded: [...current.expanded, path] });
      void controller.list(checkout, path).catch(controller.report);
    } catch (error) {
      controller.report(error);
    }
  }
  /**
   * Starts, keeps or cancels the pending expansion of the collapsed folder under a drag, other
   * than one of the `dragged` entries or inside one.
   */
  function hoverForDrag(row: VisibleRow | undefined, dragged: readonly string[]) {
    const path =
      row?.directory &&
      !expanded.has(row.path) &&
      !dragged.some((path) => row.path === path || row.path.startsWith(path + '/'))
        ? row.path
        : null;
    if (hoverExpansion.current?.path === path) return;
    clearTimeout(hoverExpansion.current?.timer);
    hoverExpansion.current = null;
    if (path === null) return;
    const timer = window.setTimeout(() => {
      hoverExpansion.current = null;
      expandForDrag(path);
    }, 500);
    hoverExpansion.current = { path, timer };
  }
  /** Scrolls while a drag is near the tree's top or bottom edge. */
  function scrollForDrag(clientY: number) {
    const element = treeElement.current;
    if (!element) return;
    const { top, bottom } = element.getBoundingClientRect();
    if (clientY < top + rowHeight) element.scrollTop -= rowHeight / 2;
    else if (clientY > bottom - rowHeight) element.scrollTop += rowHeight / 2;
  }
  /** Drops the highlight and pending expansion; the drag itself may go on elsewhere. */
  function leaveDrag() {
    clearTimeout(hoverExpansion.current?.timer);
    hoverExpansion.current = null;
    clearTimeout(dragLeave.current);
    setDropFolder(null);
  }
  /**
   * Moves or copies dropped entries into `folder`, then expands it and selects them there. A batch
   * that fails partway records and selects the entries it did move.
   */
  async function dropEntries(paths: string[], folder: string, copy: boolean) {
    const directories = new Map(paths.map((path) => [path, isDirectory(path)]));
    const result = await runMutation(
      { checkout, kind: copy ? 'copy' : 'move', paths },
      getDropDestination(paths, folder),
      { finalFocus: returnTreeFocus },
    );
    const transferred = listTransferred(paths, result);
    if (!transferred.length) return;
    const landed = listDroppedPaths(transferred, folder);
    if (!copy)
      onMoved({
        kind: 'move',
        moves: transferred.map((from, index) => ({
          from,
          to: landed[index],
          directory: directories.get(from)!,
        })),
      });
    if (!mounted.current) return;
    try {
      selectEntries(controller, checkout, landed);
    } catch (error) {
      controller.report(error);
    }
    anchor.current = landed[0];
    const element = returnTreeFocus();
    if (element) element.focus();
  }
  /** Whether the tree takes a drag of OS files, importing them when the app can approve them. */
  const takesFiles = (dataTransfer: DataTransfer) =>
    !!selectDroppedImports && isFileDrag(dataTransfer);
  /** Why OS files can't be dropped into the tree now, or '' when they can. */
  function findFileDropProblem() {
    if (importingDrop.current) return 'Wait for the dropped files to import before dropping more.';
    if (edit) return 'Finish naming the entry before importing files.';
    if (dialogOpen)
      return 'Finish the current editor dialog or preservation before importing files.';
    if (!canRequestMutation({ checkout, kind: 'import', paths: [] }))
      return 'Open the exact import checkout before importing files.';
    return '';
  }
  /**
   * Imports files dropped from the OS into `folder`, asking before replacing entries their names
   * land on, then expands the folder and selects what was imported. One drop imports at a time.
   */
  async function importDropped(files: File[], folder: string) {
    const names = files.map((file) => file.name),
      colliding = findCollidingName(names);
    // The workspace would refuse them after the replace prompt; say why before asking anything.
    if (colliding) {
      controller.report(
        `More than one dropped item is named “${colliding}”. Drop them into different folders.`,
      );
      return;
    }
    importingDrop.current = true;
    try {
      await importApproved(files, names, folder);
    } finally {
      importingDrop.current = false;
    }
  }
  async function importApproved(files: File[], names: string[], folder: string) {
    const captured = { ...checkout },
      focusAtDrop = treeElement.current?.ownerDocument.activeElement;
    // Approval can take a while; the tree may have moved on meanwhile. An approval this abandons
    // has no release from here: its references expire unused, or go with the document.
    const references = await selectDroppedImports!(captured, files);
    if (!references.length) return;
    const recovery = controller.getSnapshot().recovery;
    if (
      !mounted.current ||
      latest.current.checkoutIdentity !== checkoutIdentity ||
      !recovery.openCheckoutIds.includes(captured.checkoutId) ||
      !recovery.checkouts.some((target) => checkoutKey(target) === checkoutIdentity)
    ) {
      controller.report('Open the exact import checkout before importing files.');
      return;
    }
    if (latest.current.edit) {
      controller.report('Finish naming the entry before importing files.');
      return;
    }
    if (latest.current.dialogOpen) {
      controller.report('Finish the current editor dialog or preservation before importing files.');
      return;
    }
    // Each reference stands for its file, so the files' names are where they land.
    if (references.length !== names.length) {
      controller.report('Only files and folders can be imported.');
      return;
    }
    const result = await runMutation(
      {
        checkout: captured,
        kind: 'import',
        paths: [],
        nativeReferences: references,
        nativeNames: names,
      },
      references.length > 1 ? folder : joinPath(folder, names[0]),
      { finalFocus: returnTreeFocus },
    );
    const landed = result.items.flatMap((item) =>
      item.outcome === 'completed' && item.destination !== undefined ? [item.destination] : [],
    );
    if (!mounted.current || (!result.completed && !landed.length)) return;
    // A name typed meanwhile keeps its field, and another checkout's tree isn't this import's.
    if (latest.current.edit || latest.current.checkoutIdentity !== checkoutIdentity) return;
    try {
      if (landed.length) selectEntries(controller, captured, landed);
      else if (folder) expandForDrag(folder);
    } catch (error) {
      controller.report(error);
    }
    if (landed.length) anchor.current = landed[0];
    // Focus the user moved elsewhere meanwhile stays there.
    const focused = treeElement.current?.ownerDocument.activeElement;
    if (focused !== focusAtDrop && !focusStayed()) return;
    const element = returnTreeFocus();
    if (element) element.focus();
  }
  useEffect(() => {
    if (!dragged.length) return;
    // The browser ends a drag on Escape with dragend; these cover a drag it abandons, or a
    // dragend that never reaches the tree. A press can't happen while a drag goes on, so one
    // means it has ended. Drops bubble here after the tree has taken its own.
    const end = () => endDrag.current();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') end();
    };
    window.addEventListener('blur', end);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('pointerdown', end, true);
    window.addEventListener('dragend', end);
    window.addEventListener('drop', end);
    return () => {
      window.removeEventListener('blur', end);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('pointerdown', end, true);
      window.removeEventListener('dragend', end);
      window.removeEventListener('drop', end);
    };
  }, [dragged.length]);
  useEffect(
    () => () => {
      endDrag.current();
    },
    [],
  );
  /** Ends a press on a row, returning focus the row took to the tree. */
  function releasePress() {
    pressing.current = false;
    const element = treeElement.current,
      focused = element?.ownerDocument.activeElement;
    if (element && focused !== element && focused?.getAttribute('role') === 'treeitem')
      if (element.contains(focused)) element.focus();
  }
  useEffect(() => {
    const release = () => releasePressRef.current();
    window.addEventListener('pointerup', release, true);
    return () => window.removeEventListener('pointerup', release, true);
  }, []);
  releasePressRef.current = releasePress;
  endDrag.current = () => {
    leaveDrag();
    if (activeDrag && activeDrag === ownDrag.current) activeDrag = null;
    ownDrag.current = null;
    setDragged((current) => (current.length ? [] : current));
  };
  const navigation: TreeNavigation = {
    controller,
    checkout,
    rows: treeRows,
    focusIndex: treeFocusIndex,
    selection: tree.selected,
    expanded,
    anchor,
    toggle,
    openMenuBelow(path) {
      const rect = document.getElementById(rowId(path))!.getBoundingClientRect();
      openMenu(path, rect.left, rect.bottom);
    },
    commandsFor: (paths) => listFileCommands(commandContext, paths),
    undo() {
      if (!undoLabel) return;
      void onUndo(returnTreeFocus).then((undone) => {
        if (!undone || !mounted.current) return;
        anchor.current = null;
        if (focusStayed()) {
          const element = returnTreeFocus();
          if (element) element.focus();
        }
      });
    },
    cancelCut: onCancelCut,
  };
  const root = state.listings[JSON.stringify([checkoutIdentity, ''])];
  const mountedIndexes = selectMountedIndexes({
    rows,
    top: geometry.top,
    height: geometry.height,
    focusIndex,
    // Chromium stops a drag whose source row unmounts.
    pinnedPaths: editPath === null ? dragged : [editPath, ...dragged],
  });
  return (
    <>
      {Object.entries(state.listings)
        .filter(([key]) => key.startsWith(JSON.stringify([checkoutIdentity]).slice(0, -1) + ','))
        .map(([key, listing]) =>
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
        onDragStart={(event) => {
          // A drag whose end never arrived is over once another starts.
          endDrag.current();
          const row = findRowAt(event.target);
          if (!row) return;
          const paths = selectDraggedPaths(row.path, tree.selected);
          if (paths.length > maxDraggedEntries) {
            event.preventDefault();
            controller.report(`Drag at most ${maxDraggedEntries} items at a time.`);
            return;
          }
          if (edit || dialogOpen || !canRequestMutation({ checkout, kind: 'move', paths })) {
            event.preventDefault();
            return;
          }
          const drag = { source: controller.instanceId, checkout: checkoutIdentity, paths };
          event.dataTransfer.setData(entriesType, JSON.stringify(drag));
          // Dropped into the editor or a chat, the drag is its paths as text.
          event.dataTransfer.setData('text/plain', paths.join('\n'));
          event.dataTransfer.effectAllowed = 'copyMove';
          if (paths.length > 1) setCountImage(event.dataTransfer, paths.length);
          activeDrag = ownDrag.current = drag;
          setMenu(null);
          // The grabbed row stays mounted even when it moves with a dragged folder.
          setDragged([...new Set([row.path, ...paths])]);
        }}
        onDragEnd={() => {
          endDrag.current();
          releasePress();
        }}
        onDragEnter={(event) => {
          if (takesFiles(event.dataTransfer)) {
            clearTimeout(dragLeave.current);
            // Refused here, the drop is still the tree's, so the app doesn't import it elsewhere.
            event.preventDefault();
            return;
          }
          if (!event.dataTransfer.types.includes(entriesType)) return;
          clearTimeout(dragLeave.current);
          // Entering a row that takes the drop must be accepted too, or the browser passes the
          // drag to the page instead.
          if (planDropInto(findDropFolder(findRowAt(event.target)))) event.preventDefault();
        }}
        onDragOver={(event) => {
          if (takesFiles(event.dataTransfer)) {
            clearTimeout(dragLeave.current);
            event.preventDefault();
            scrollForDrag(event.clientY);
            const row = findRowAt(event.target);
            hoverForDrag(row, []);
            const refused = !!findFileDropProblem();
            event.dataTransfer.dropEffect = refused ? 'none' : 'copy';
            setDropFolder(refused ? null : findDropFolder(row));
            return;
          }
          // Other drags pass through to the app.
          if (!event.dataTransfer.types.includes(entriesType)) return;
          clearTimeout(dragLeave.current);
          if (
            activeDrag?.source !== controller.instanceId ||
            activeDrag.checkout !== checkoutIdentity
          ) {
            event.dataTransfer.dropEffect = 'none';
            return;
          }
          scrollForDrag(event.clientY);
          const row = findRowAt(event.target);
          hoverForDrag(row, activeDrag.paths);
          const folder = findDropFolder(row);
          if (!planDropInto(folder)) {
            event.dataTransfer.dropEffect = 'none';
            setDropFolder(null);
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = event.altKey ? 'copy' : 'move';
          setDropFolder(folder);
        }}
        onDragLeave={(event) => {
          if (!event.dataTransfer.types.includes(entriesType) && !takesFiles(event.dataTransfer))
            return;
          // Moving between rows leaves one as it enters the next; only leaving the tree counts.
          clearTimeout(dragLeave.current);
          dragLeave.current = window.setTimeout(leaveDrag, 50);
        }}
        onDrop={(event) => {
          if (takesFiles(event.dataTransfer)) {
            // Taken, so the app's window-wide drop doesn't import the files at the root too.
            event.preventDefault();
            takeFileDrop(event.nativeEvent);
            const files = [...event.dataTransfer.files],
              folder = findDropFolder(findRowAt(event.target)),
              problem = findFileDropProblem();
            leaveDrag();
            if (!files.length) return;
            if (problem) controller.report(problem);
            else void importDropped(files, folder).catch(controller.report);
            return;
          }
          if (!event.dataTransfer.types.includes(entriesType)) return;
          event.preventDefault();
          // Only the drag this document started, as the DataTransfer confirms, drops.
          const ours = isSameDrag(event.dataTransfer.getData(entriesType), activeDrag);
          const folder = findDropFolder(findRowAt(event.target)),
            paths = ours ? planDropInto(folder) : null,
            copy = event.altKey;
          endDrag.current();
          if (paths) void dropEntries(paths, folder, copy);
        }}
        onPointerDown={(event) => {
          if (event.button === 0) pressing.current = true;
        }}
        onFocus={(event) => {
          // A row's name field keeps the focus, and its keys, while a name is typed.
          if (isNameField(event.target)) return;
          // Moving focus while a row is pressed would cancel a drag from it; the press's end
          // returns focus to the tree instead.
          if (pressing.current && event.target !== event.currentTarget) return;
          if (event.currentTarget.contains(event.target)) event.currentTarget.focus();
        }}
        onScroll={(event) => {
          if (event.target !== event.currentTarget) return;
          const top = event.currentTarget.scrollTop;
          setMenu((current) => (current?.scroll === top ? current : null));
          setGeometry((old) => ({ ...old, top }));
          controller.tree(checkout, { scroll: top });
        }}
        onKeyDown={(event) => {
          if (!isNameField(event.target)) handleTreeKeyDown(event, navigation);
        }}>
        <div {...stylex.props(styles.treeExtent(rows.length * rowHeight))}>
          {mountedIndexes.map((index) => {
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
                      label={editLabels[editing.kind]}
                      initial={startingName(editing)}
                      directory={row.directory}
                      onCommit={(name, how, next) => commitEdit(editing, name, how, next)}
                      onCancel={() => endEdit(editing, undefined, true)}
                    />
                  )
                }
                onOpenMenu={openMenu}
                onSelect={(row, additive) => {
                  if (row.path === editPath) return;
                  treeElement.current?.focus();
                  handleRowClick(navigation, row, additive);
                }}
                onOpen={(path) => {
                  if (path === editPath) return;
                  void controller.open({ checkout, path }, { view: 'file', intent: 'keep' });
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
      <ContextMenu.Root
        open={menuAvailable}
        onOpenChange={(open) => {
          if (!open) setMenu(null);
        }}>
        <ContextMenu.Portal>
          <ContextMenu.Backdrop
            {...stylex.props(overlays.menuBackdrop)}
            onClick={() => setMenu(null)}
          />
          <ContextMenu.Positioner
            anchor={menu ? { getBoundingClientRect: () => menu.point } : null}
            collisionPadding={8}
            {...stylex.props(overlays.positioner)}>
            <ContextMenu.Popup
              aria-label="File actions"
              finalFocus={() => (restoreMenuFocus.current ? returnTreeFocus() : false)}
              onFocus={(event) => {
                if (event.target === event.currentTarget)
                  event.currentTarget.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
              }}
              onKeyDownCapture={(event) => {
                if (event.key === 'Tab') {
                  restoreMenuFocus.current = false;
                  setMenu(null);
                  const element = returnTreeFocus();
                  if (element) element.focus();
                  event.stopPropagation();
                }
              }}
              {...stylex.props(overlays.popup, overlays.menuPopup, overlays.wideMenu)}>
              {menu &&
                listFileCommands(commandContext, menu.paths, menu.path).map((item, index) =>
                  item === 'separator' ? (
                    <ContextMenu.Separator key={index} {...stylex.props(overlays.separator)} />
                  ) : (
                    <ContextMenu.Item
                      key={item.id}
                      disabled={item.disabled}
                      aria-keyshortcuts={item.keys && ariaKeys(item.keys)}
                      {...stylex.props(
                        overlays.option,
                        overlays.menuItem,
                        overlays.commandItem,
                        item.danger && overlays.dangerItem,
                      )}
                      onClick={() => {
                        if (item.disabled) return;
                        // Copy and reveal leave focus in the tree; the rest move it to a dialog,
                        // the editor or the chat.
                        restoreMenuFocus.current = !!item.staysInTree;
                        setMenu(null);
                        item.run();
                      }}>
                      <span {...stylex.props(overlays.commandIcon)}>
                        <Icon name={item.icon} />
                      </span>
                      <span {...stylex.props(overlays.commandLabel)}>{item.label}</span>
                      {item.keys && (
                        <span aria-hidden="true" {...stylex.props(overlays.commandKeys)}>
                          {formatKeys(item.keys)}
                        </span>
                      )}
                    </ContextMenu.Item>
                  ),
                )}
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </>
  );
}
