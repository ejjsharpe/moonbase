import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { styles } from './styles.ts';
import { Icon } from './icon.tsx';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
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

const isContextClick = (event: { button: number; ctrlKey: boolean }) =>
  event.button === 2 || (event.button === 0 && event.ctrlKey && navigator.platform.includes('Mac'));

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
  const rows: {
    path: string;
    directory: boolean;
    level: number;
    ignored?: boolean;
    position: number;
    size: number;
  }[] = [];
  function visit(parent: string, level: number) {
    const entries = state.listings[JSON.stringify([checkoutIdentity, parent])]?.entries ?? [];
    entries.forEach((entry, index) => {
      rows.push({ ...entry, level, position: index + 1, size: entries.length });
      if (entry.directory && expanded.has(entry.path)) visit(entry.path, level + 1);
    });
  }
  visit('', 1);
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
    const top = focusIndex * 28;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + 28 > element.scrollTop + element.clientHeight)
      element.scrollTop = top + 28 - element.clientHeight;
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
  const root = state.listings[JSON.stringify([checkoutIdentity, ''])];
  const indexes = new Set<number>([focusIndex]);
  for (
    let index = Math.max(0, Math.floor(geometry.top / 28) - 10);
    index < Math.min(rows.length, Math.ceil((geometry.top + geometry.height) / 28) + 10);
    index++
  )
    indexes.add(index);
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
          rows[focusIndex] ? `${id}-${encodeURIComponent(rows[focusIndex].path)}` : undefined
        }
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
        onKeyDown={(event) => {
          if (!event.currentTarget.contains(event.target as Node)) return;
          const row = rows[focusIndex];
          if (!row) return;
          let next = focusIndex;
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            event.stopPropagation();
            const element = document.getElementById(`${id}-${encodeURIComponent(row.path)}`)!;
            const rect = element.getBoundingClientRect();
            openMenu(row.path, rect.left, rect.bottom);
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
            const selection = event.shiftKey
              ? rows.slice(Math.min(start, next), Math.max(start, next) + 1).map((row) => row.path)
              : [rows[next].path];
            if (!event.shiftKey) anchor.current = rows[next].path;
            controller.tree(checkout, { focus: rows[next].path, selected: selection });
          } else if (event.key === 'ArrowRight' && row.directory) {
            anchor.current = null;
            event.preventDefault();
            if (!expanded.has(row.path)) toggle(row.path);
          } else if (event.key === 'ArrowLeft') {
            anchor.current = null;
            event.preventDefault();
            if (row.directory && expanded.has(row.path)) toggle(row.path);
            else controller.tree(checkout, { focus: row.path.split('/').slice(0, -1).join('/') });
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (row.directory) toggle(row.path);
            else
              void controller.open(
                { checkout, path: row.path },
                { view: 'file', intent: event.key === ' ' ? 'preview' : 'keep' },
              );
          } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
            event.preventDefault();
            controller.tree(checkout, { selected: rows.map((row) => row.path) });
          }
        }}>
        <div {...stylex.props(styles.treeExtent(rows.length * 28))}>
          {[...indexes]
            .sort((a, b) => a - b)
            .map((index) => {
              const row = rows[index];
              if (!row) return null;
              const dirty = dirtyPaths.has(row.path);
              const folderIcon = expanded.has(row.path) ? 'folderOpen' : 'folder';
              return (
                <div
                  key={row.path}
                  id={`${id}-${encodeURIComponent(row.path)}`}
                  role="treeitem"
                  tabIndex={-1}
                  aria-level={row.level}
                  aria-posinset={row.position}
                  aria-setsize={row.size}
                  aria-expanded={row.directory ? expanded.has(row.path) : undefined}
                  aria-selected={selected.has(row.path)}
                  aria-current={row.path === active ? 'true' : undefined}
                  aria-label={row.path + (dirty ? ', unsaved' : '')}
                  aria-description={row.ignored ? 'Git-ignored' : undefined}
                  {...stylex.props(
                    styles.treeRow(index * 28),
                    filesUI.row(row.level),
                    row.ignored && filesUI.ignored,
                    selected.has(row.path) && filesUI.selected,
                    tree.focus === row.path && filesUI.focused,
                  )}
                  onContextMenu={(event) => {
                    if (!event.currentTarget.contains(event.target as Node)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    openMenu(row.path, event.clientX, event.clientY);
                  }}
                  onPointerDown={(event) => {
                    if (isContextClick(event)) event.preventDefault();
                  }}
                  onClick={(event) => {
                    if (
                      !event.currentTarget.contains(event.target as Node) ||
                      event.button !== 0 ||
                      isContextClick(event)
                    )
                      return;
                    treeElement.current?.focus();
                    anchor.current = row.path;
                    const additive = event.metaKey || event.ctrlKey;
                    let selected = [row.path];
                    if (additive)
                      selected = tree.selected.includes(row.path)
                        ? tree.selected.filter((path) => path !== row.path)
                        : [...tree.selected, row.path];
                    if (!additive && row.directory) {
                      toggle(row.path, true);
                      return;
                    }
                    controller.tree(checkout, { focus: row.path, selected });
                    if (!additive) {
                      void controller.open(
                        { checkout, path: row.path },
                        { view: 'file', intent: 'preview' },
                      );
                    }
                  }}
                  onDoubleClick={(event) => {
                    if (event.button !== 0 || isContextClick(event)) return;
                    if (!row.directory)
                      void controller.open(
                        { checkout, path: row.path },
                        { view: 'file', intent: 'keep' },
                      );
                  }}>
                  <span
                    aria-hidden="true"
                    {...stylex.props(
                      filesUI.disclosure,
                      row.directory && expanded.has(row.path) && filesUI.rotated,
                    )}>
                    {row.directory && <Icon name="chevronRight" />}
                  </span>
                  <Icon name={row.directory ? folderIcon : 'file'} />
                  <span
                    {...stylex.props(
                      styles.treeLabel,
                      row.path === active && filesUI.activeLabel,
                      row.ignored && filesUI.ignored,
                    )}>
                    {row.path.split('/').at(-1)}
                  </span>
                  {dirty && <span aria-hidden="true"> •</span>}
                </div>
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
              {...stylex.props(overlays.popup, overlays.menuPopup)}>
              {(['move', 'copy', 'trash'] as const).map((kind) => (
                <ContextMenu.Item
                  key={kind}
                  disabled={
                    !menu ||
                    !canRequestMutation({ checkout: menu.checkout, paths: menu.paths, kind })
                  }
                  {...stylex.props(overlays.option, overlays.menuItem)}
                  onClick={() => {
                    if (!menu) return;
                    restoreMenuFocus.current = false;
                    requestMutation(
                      { checkout: menu.checkout, paths: menu.paths, kind },
                      returnTreeFocus,
                    );
                    setMenu(null);
                  }}>
                  {{ move: 'Rename', copy: 'Copy', trash: 'Move to Trash' }[kind]}
                </ContextMenu.Item>
              ))}
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </>
  );
}
