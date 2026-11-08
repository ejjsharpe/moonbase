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
import { ariaKeys, formatKeys, listFileCommands } from './file-commands.ts';
import { handleRowClick, handleTreeKeyDown, type TreeNavigation } from './files-tree-keyboard.ts';
import { FilesTreeRow } from './files-tree-row.tsx';
import { listVisibleRows, rowHeight, selectMountedIndexes } from './files-tree-rows.ts';
import { rollUpGitStatus } from './files-tree-status.ts';

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
  requestMutation: (
    action: MutationAction,
    finalFocus: () => HTMLElement | false,
    destination?: string,
  ) => void;
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
  const rows = listVisibleRows(state.listings, checkoutIdentity, expanded);
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
  const commandContext = {
    controller,
    checkout,
    listings: state.listings,
    canRequestMutation,
    requestMutation,
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
  );
  useEffect(() => {
    const element = treeElement.current;
    if (!element || !rows.length) return;
    const top = focusIndex * rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + element.clientHeight)
      element.scrollTop = top + rowHeight - element.clientHeight;
  }, [tree.focus, focusIndex, rows.length]);
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
    rows,
    focusIndex,
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
        aria-activedescendant={rows[focusIndex] ? rowId(rows[focusIndex].path) : undefined}
        {...stylex.props(filesUI.tree, stylex.defaultMarker())}
        onFocus={(event) => {
          if (event.currentTarget.contains(event.target)) event.currentTarget.focus();
        }}
        onScroll={(event) => {
          if (event.target !== event.currentTarget) return;
          const top = event.currentTarget.scrollTop;
          setMenu((current) => (current?.scroll === top ? current : null));
          setGeometry((old) => ({ ...old, top }));
          controller.tree(checkout, { scroll: top });
        }}
        onKeyDown={(event) => handleTreeKeyDown(event, navigation)}>
        <div {...stylex.props(styles.treeExtent(rows.length * rowHeight))}>
          {mountedIndexes.map((index) => {
            const row = rows[index];
            return (
              <FilesTreeRow
                key={row.path}
                id={rowId(row.path)}
                row={row}
                index={index}
                expanded={expanded.has(row.path)}
                selected={selected.has(row.path)}
                focused={tree.focus === row.path}
                active={row.path === active}
                dirty={dirtyPaths.has(row.path)}
                status={statuses.get(row.path)}
                onOpenMenu={openMenu}
                onSelect={(row, additive) => {
                  treeElement.current?.focus();
                  handleRowClick(navigation, row, additive);
                }}
                onOpen={(path) => {
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
