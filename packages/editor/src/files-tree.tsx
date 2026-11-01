import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { styles } from './styles.ts';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { filesUI } from '@moonbase/ui/files';
import type { CheckoutTarget } from '@moonbase/application/client';
import { checkoutKey, fileKey, type EditorController, type EditorSnapshot } from './editor.ts';
import { readOwn } from './record.ts';

export function FilesTree({
  controller,
  state,
  checkout,
  active,
  anchorReset,
}: {
  controller: EditorController;
  state: EditorSnapshot;
  checkout: CheckoutTarget;
  active: string;
  anchorReset: number;
}) {
  const tree = readOwn(state.recovery.views, checkout.checkoutId)!.tree,
    treeElement = useRef<HTMLDivElement>(null),
    anchor = useRef<string | null>(null),
    id = useId();
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
    const entries = state.listings[JSON.stringify([checkoutKey(checkout), parent])]?.entries ?? [];
    entries.forEach((entry, index) => {
      rows.push({ ...entry, level, position: index + 1, size: entries.length });
      if (entry.directory && tree.expanded.includes(entry.path)) visit(entry.path, level + 1);
    });
  }
  visit('', 1);
  const checkoutIdentity = checkoutKey(checkout);
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
  function toggle(path: string) {
    controller.tree(checkout, {
      expanded: tree.expanded.includes(path)
        ? tree.expanded.filter((value) => value !== path)
        : [...tree.expanded, path],
    });
    void controller.list(checkout, path).catch(controller.report);
  }
  const root = state.listings[JSON.stringify([checkoutKey(checkout), ''])];
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
        .filter(([key]) => key.includes(checkoutKey(checkout).replaceAll('"', '\\"')))
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
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop;
          setGeometry((old) => ({ ...old, top }));
          controller.tree(checkout, { scroll: top });
        }}
        onKeyDown={(event) => {
          const row = rows[focusIndex];
          if (!row) return;
          let next = focusIndex;
          if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
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
            if (!tree.expanded.includes(row.path)) toggle(row.path);
          } else if (event.key === 'ArrowLeft') {
            anchor.current = null;
            event.preventDefault();
            if (row.directory && tree.expanded.includes(row.path)) toggle(row.path);
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
              const dirty = state.buffers.some(
                (buffer) =>
                  fileKey(buffer.target) === fileKey({ checkout, path: row.path }) &&
                  buffer.text !== buffer.disk.text,
              );
              return (
                <div
                  key={row.path}
                  id={`${id}-${encodeURIComponent(row.path)}`}
                  role="treeitem"
                  aria-level={row.level}
                  aria-posinset={row.position}
                  aria-setsize={row.size}
                  aria-expanded={row.directory ? tree.expanded.includes(row.path) : undefined}
                  aria-selected={tree.selected.includes(row.path)}
                  aria-current={row.path === active ? 'true' : undefined}
                  aria-label={row.path + (dirty ? ', unsaved' : '')}
                  {...stylex.props(
                    styles.treeRow(index * 28),
                    filesUI.row(row.level),
                    tree.selected.includes(row.path) && filesUI.selected,
                    tree.focus === row.path && filesUI.focused,
                  )}
                  onClick={(event) => {
                    treeElement.current?.focus();
                    anchor.current = row.path;
                    const additive = event.metaKey || event.ctrlKey;
                    let selected = [row.path];
                    if (additive)
                      selected = tree.selected.includes(row.path)
                        ? tree.selected.filter((path) => path !== row.path)
                        : [...tree.selected, row.path];
                    controller.tree(checkout, { focus: row.path, selected });
                    if (!additive) {
                      if (row.directory) toggle(row.path);
                      else
                        void controller.open(
                          { checkout, path: row.path },
                          { view: 'file', intent: 'preview' },
                        );
                    }
                  }}
                  onDoubleClick={() => {
                    if (!row.directory)
                      void controller.open(
                        { checkout, path: row.path },
                        { view: 'file', intent: 'keep' },
                      );
                  }}>
                  {row.directory && (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      aria-hidden="true"
                      {...stylex.props(
                        controls.icon,
                        tree.expanded.includes(row.path) && filesUI.rotated,
                      )}>
                      <path d="m4 2 4 4-4 4" />
                    </svg>
                  )}
                  <span
                    {...stylex.props(styles.treeLabel, row.path === active && filesUI.activeLabel)}>
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
    </>
  );
}
