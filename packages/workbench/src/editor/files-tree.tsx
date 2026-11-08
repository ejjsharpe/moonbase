import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { styles } from './styles.ts';
import { Icon } from './icon.tsx';
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
} from './file-commands.ts';
import { handleRowClick, handleTreeKeyDown, type TreeNavigation } from './files-tree-keyboard.ts';
import { FilesTreeName, type NameCommit } from './files-tree-name.tsx';
import { FilesTreeRow } from './files-tree-row.tsx';
import {
  listVisibleRows,
  measureStem,
  placeholderPath,
  rowHeight,
  selectMountedIndexes,
  type RowPlaceholder,
} from './files-tree-rows.ts';
import { rollUpGitStatus } from './files-tree-status.ts';
import type { RunMutation } from './mutation-runner.tsx';

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

const isNameField = (target: EventTarget) =>
  target instanceof HTMLElement && target.tagName === 'INPUT';
const parentOf = (path: string) => path.split('/').slice(0, -1).join('/');
const nameOf = (path: string) => path.split('/').at(-1)!;
/** Whether an element that took focus can take it again. */
const canRefocus = (element: Element | null): element is HTMLElement =>
  element instanceof HTMLElement &&
  element.isConnected &&
  element.getClientRects().length > 0 &&
  !element.matches(':disabled') &&
  !element.closest('[inert]');
/** `name copy.ext`, the name a duplicate starts with. */
function copyName(name: string) {
  const stem = measureStem(name, false);
  return `${name.slice(0, stem)} copy${name.slice(stem)}`;
}
/** The name a field starts with: an entry's own, its copy's, or none for a new one. */
function startingName(edit: TreeEdit) {
  if (edit.kind === 'rename') return nameOf(edit.path);
  return edit.kind === 'duplicate' ? copyName(nameOf(edit.path)) : '';
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
  dialogOpen,
  canRequestMutation,
  requestMutation,
  runMutation,
  createRequest,
  onCreateRequestTaken,
  copyPaths,
  revealPath,
  mentionInChat,
}: {
  controller: EditorController;
  state: EditorSnapshot;
  checkout: CheckoutTarget;
  active: string;
  anchorReset: number;
  visible: boolean;
  dialogOpen: boolean;
  canRequestMutation: (action: MutationAction) => boolean;
  requestMutation: (action: MutationAction, finalFocus: () => HTMLElement | false) => void;
  runMutation: RunMutation;
  createRequest: TreeCreateRequest | null;
  /** Called once the tree has started `createRequest`'s edit. */
  onCreateRequestTaken: () => void;
  /** Copies a checkout's paths to the clipboard, joined by newlines: absolute, or as `relative`. */
  copyPaths?: (checkout: CheckoutTarget, paths: string[], relative: boolean) => Promise<void>;
  /** Shows a checkout's file or folder in the OS file manager. */
  revealPath?: (checkout: CheckoutTarget, path: string) => Promise<void>;
  /** Mentions files in the chat beside this checkout. */
  mentionInChat?: (checkout: CheckoutTarget, paths: string[]) => void;
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
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const creating = edit?.kind === 'create-file' || edit?.kind === 'create-directory';
  const editParent = edit && (creating ? edit.path : parentOf(edit.path));
  let placeholder: RowPlaceholder | undefined;
  if (edit && edit.kind !== 'rename')
    placeholder = {
      parent: editParent!,
      directory: edit.kind === 'create-directory',
      ...(edit.kind === 'duplicate' ? { after: edit.path } : {}),
    };
  const editPath = edit && (edit.kind === 'rename' ? edit.path : placeholderPath(editParent!));
  // Rows as shown, with any placeholder; keyboard navigation and selection skip the placeholder.
  const rows = listVisibleRows(state.listings, checkoutIdentity, expanded, placeholder),
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
      const parts = path ? path.split('/') : [];
      const opening = parts
        .map((_, index) => parts.slice(0, index + 1).join('/'))
        .filter((folder) => !current.expanded.includes(folder));
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
      parent = create ? current.path : parentOf(current.path);
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
    if (current.kind === 'rename' && name === nameOf(current.path)) return end(current.path);
    const destination = parent ? `${parent}/${name}` : name;
    let error = '';
    committing.current = true;
    const completed = await runMutation(
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
      if (current.kind === 'create-file' && mounted.current)
        void controller
          .open({ checkout, path: destination }, { view: 'file', intent: 'keep' })
          .catch(controller.report);
      return end(destination);
    }
    if (error) return error;
    return enter ? '' : end();
  }
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
  };
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
  };
  const root = state.listings[JSON.stringify([checkoutIdentity, ''])];
  const mountedIndexes = selectMountedIndexes({
    rows,
    top: geometry.top,
    height: geometry.height,
    focusIndex,
    pinnedPaths: editPath === null ? [] : [editPath],
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
        {...stylex.props(filesUI.tree, stylex.defaultMarker())}
        onFocus={(event) => {
          // A row's name field keeps the focus, and its keys, while a name is typed.
          if (isNameField(event.target)) return;
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
                status={statuses.get(row.path)}
                label={label}
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
                listFileCommands(commandContext, menu.paths).map((item, index) =>
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
