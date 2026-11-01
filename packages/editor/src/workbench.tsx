import { readOwn } from './record.ts';
import {
  forwardRef,
  useEffect,
  useCallback,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@base-ui/react/button';
import { Dialog } from '@base-ui/react/dialog';
import { Tabs } from '@base-ui/react/tabs';
import { Menu } from '@base-ui/react/menu';
import { controls } from '@moonbase/ui/controls';
import { filesUI } from '@moonbase/ui/files';
import { workbench } from '@moonbase/ui/workbench';
import { overlays } from '@moonbase/ui/overlays';
import type {
  CheckoutTarget,
  EntryReference,
  FileView,
  LookupMatch,
  WorkspaceOperation,
} from '@moonbase/application/client';
import {
  checkoutKey,
  fileKey,
  type ChooseClose,
  type CloseChoice,
  type EditorBuffer,
  type EditorController,
  type EditorSnapshot,
} from './editor.ts';
import { MonacoView } from './monaco-view.tsx';
import { styles } from './styles.ts';

type FocusOrigin = 'editor' | 'strip' | 'tree';
const focusOrigin = (element: HTMLElement): FocusOrigin => {
  if (element.closest('[role="tree"]')) {
    return 'tree';
  } else {
    if (element.closest('[aria-label="Open files"]')) {
      return 'strip';
    } else {
      return 'editor';
    }
  }
};

function Popup({
  title,
  children,
  onClose,
  finalFocus,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  finalFocus?: () => boolean | HTMLElement | null;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}>
      <Dialog.Portal>
        <Dialog.Backdrop {...stylex.props(styles.backdrop)} />
        <Dialog.Popup finalFocus={finalFocus} {...stylex.props(overlays.dialog, styles.popup)}>
          <Dialog.Title {...stylex.props(overlays.dialogTitle)}>{title}</Dialog.Title>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function FileLookup({
  controller,
  state,
  checkout,
  close,
  editorFocus,
}: {
  controller: EditorController;
  state: EditorSnapshot;
  checkout: CheckoutTarget;
  close: () => void;
  editorFocus: () => HTMLElement | null;
}) {
  const [query, setQuery] = useState(''),
    [all, setAll] = useState(false),
    [refresh, setRefresh] = useState(0);
  const [rows, setRows] = useState<(LookupMatch & { checkout: CheckoutTarget; recent: boolean })[]>(
    [],
  );
  const [index, setIndex] = useState(0),
    [message, setMessage] = useState('Type a filename or path.'),
    [busy, setBusy] = useState(false);
  const active = useRef(true),
    request = useRef(0),
    activated = useRef(false),
    id = useId();
  const scope = all
      ? state.recovery.checkouts.filter((target) =>
          state.recovery.openCheckoutIds.includes(target.checkoutId),
        )
      : [checkout],
    scopeKey = JSON.stringify(scope);
  useEffect(
    () => () => {
      active.current = false;
      request.current++;
    },
    [],
  );
  useEffect(() => {
    const requestCounter = request;
    const scope: CheckoutTarget[] = JSON.parse(scopeKey);
    const generation = ++requestCounter.current;
    // oxlint-disable-next-line react/set-state-in-effect -- A new search must hide stale selectable results before its async reply.
    setRows([]);
    setIndex(0);
    const timer = setTimeout(() => {
      void Promise.allSettled(
        scope.slice(0, 8).map(async (checkout) => ({
          checkout,
          result: await controller.lookup(checkout, query),
        })),
      ).then((results) => {
        if (!active.current || generation !== request.current) return;
        const rows: (LookupMatch & { checkout: CheckoutTarget; recent: boolean })[] = [],
          errors: string[] = [];
        let partial = scope.length > 8;
        for (const result of results) {
          if (result.status === 'rejected') {
            errors.push(String(result.reason));
            continue;
          }
          const { checkout, result: value } = result.value;
          partial ||= value.partial;
          if (value.error) errors.push(value.error);
          for (const recent of value.history) rows.push({ ...recent, checkout, recent: true });
          for (const match of value.matches) rows.push({ ...match, checkout, recent: false });
        }
        const unique = [
          ...new Map(
            rows.map((row) => [fileKey({ checkout: row.checkout, path: row.path }), row]),
          ).values(),
        ];
        unique.sort(
          (a, b) => Number(b.recent) - Number(a.recent) || (a.recent ? 0 : b.score - a.score),
        );
        setRows(unique.slice(0, 100));
        setMessage(
          `${Math.min(unique.length, 100)} results${partial || unique.length > 100 ? '; partial coverage. Refine the query or Refresh.' : ''}${errors.length ? '; ' + errors.join('; ') : ''}`,
        );
      });
    }, 120);
    return () => {
      clearTimeout(timer);
      requestCounter.current++;
    };
  }, [query, scopeKey, refresh, controller, state.discoveryRevision]);
  async function open(row = rows[index]) {
    if (busy) return;
    setBusy(true);
    const generation = ++request.current;
    try {
      if (!row && all) {
        setMessage('Choose one exact checkout result, or search in the active checkout.');
        return;
      }
      const target = row ? { checkout: row.checkout, path: row.path } : { checkout, path: query };
      const current = () =>
        active.current &&
        generation === request.current &&
        controller.getSnapshot().recovery.openCheckoutIds.includes(target.checkout.checkoutId) &&
        controller
          .getSnapshot()
          .recovery.checkouts.some((item) => checkoutKey(item) === checkoutKey(target.checkout));
      if ((await controller.open(target, { view: 'file', intent: 'keep', current })) && current()) {
        activated.current = true;
        close();
      } else
        setMessage(
          'File unavailable. Your current selection and edits are retained. Edit the path or retry.',
        );
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Popup
      title="Find file"
      onClose={close}
      finalFocus={() => (activated.current ? (editorFocus() ?? false) : true)}>
      <Dialog.Description {...stylex.props(styles.path)}>
        {all ? 'Search exactly the open checkouts.' : checkout.root}
      </Dialog.Description>
      <label {...stylex.props(styles.label)}>
        Filename or exact relative path
        <input
          {...stylex.props(controls.field)}
          value={query}
          autoFocus
          role="combobox"
          aria-controls={id}
          aria-expanded={rows.length > 0}
          aria-activedescendant={rows[index] ? `${id}-${index}` : undefined}
          onChange={(event) => {
            request.current++;
            setQuery(event.target.value);
          }}
          maxLength={4096}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void open();
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setIndex((index) => {
                if (rows.length) {
                  return (index + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
                } else {
                  return 0;
                }
              });
            }
          }}
        />
      </label>
      <label>
        <input type="checkbox" checked={all} onChange={(event) => setAll(event.target.checked)} />{' '}
        All open checkouts
      </label>
      <div id={id} role="listbox" aria-label="Matching files" {...stylex.props(styles.lookupList)}>
        {[true, false].map((recent) => (
          <div
            key={String(recent)}
            role="group"
            aria-label={recent ? 'Recent files' : 'File results'}>
            {rows.some((row) => row.recent === recent) && (
              <h3 {...stylex.props(controls.heading)}>
                {recent ? 'Recent files' : 'File results'}
              </h3>
            )}
            {rows.map((row, rowIndex) => {
              if (row.recent !== recent) {
                return null;
              } else {
                return (
                  <div
                    role="option"
                    aria-selected={rowIndex === index}
                    id={`${id}-${rowIndex}`}
                    key={fileKey({ checkout: row.checkout, path: row.path })}
                    {...stylex.props(
                      overlays.result,
                      rowIndex === index && overlays.selectedResult,
                    )}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void open(row)}>
                    {[...row.path].map((character, position) =>
                      row.positions.includes(position) ? (
                        <mark key={position} {...stylex.props(overlays.mark)}>
                          {character}
                        </mark>
                      ) : (
                        character
                      ),
                    )}
                    {all && (
                      <small {...stylex.props(overlays.lookupRoot)}>
                        {row.checkout.branch} · {row.checkout.root}
                      </small>
                    )}
                  </div>
                );
              }
            })}
          </div>
        ))}
      </div>
      <p role="status" {...stylex.props(controls.status, overlays.dialogStatus)}>
        {message}
      </p>
      <div {...stylex.props(styles.dialogActions)}>
        <Button
          {...stylex.props(controls.button)}
          disabled={busy || (!query && !rows.length)}
          onClick={() => void open()}>
          Open file
        </Button>
        <Button
          {...stylex.props(controls.button)}
          disabled={busy}
          onClick={() => setRefresh((value) => value + 1)}>
          Refresh
        </Button>
        <Button {...stylex.props(controls.button)} onClick={close}>
          Cancel
        </Button>
      </div>
    </Popup>
  );
}

function FilesTree({
  controller,
  state,
  checkout,
  active,
}: {
  controller: EditorController;
  state: EditorSnapshot;
  checkout: CheckoutTarget;
  active: string;
}) {
  const tree = readOwn(state.recovery.views, checkout.checkoutId)!.tree,
    treeElement = useRef<HTMLDivElement>(null),
    id = useId();
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
            const selection = event.shiftKey
              ? rows
                  .slice(Math.min(focusIndex, next), Math.max(focusIndex, next) + 1)
                  .map((row) => row.path)
              : [rows[next].path];
            controller.tree(checkout, { focus: rows[next].path, selected: selection });
          } else if (event.key === 'ArrowRight' && row.directory) {
            event.preventDefault();
            if (!tree.expanded.includes(row.path)) toggle(row.path);
          } else if (event.key === 'ArrowLeft') {
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

type Action = {
  checkout: CheckoutTarget;
  kind: WorkspaceOperation['kind'];
  paths: string[];
  nativeReferences?: string[];
};
function Mutation({
  controller,
  action,
  close,
}: {
  controller: EditorController;
  action: Action;
  close: () => void;
}) {
  const checkout = action.checkout,
    batchImport = action.kind === 'import' && action.nativeReferences!.length > 1;
  const [destination, setDestination] = useState(
      action.kind === 'move' ? (action.paths[0] ?? '') : '',
    ),
    [error, setError] = useState('');
  const [replacementPaths, setReplacementPaths] = useState('');
  const [replacements, setReplacements] = useState<EntryReference[] | null>(null),
    [sources, setSources] = useState<EntryReference[] | null>(null),
    [busy, setBusy] = useState(false);
  const [operationId] = useState(() => crypto.randomUUID());
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  let title;
  if (action.kind === 'trash') {
    title = 'Move to Trash';
  } else {
    if (action.kind === 'move') {
      title = 'Rename or move';
    } else {
      if (action.kind === 'copy') {
        title = 'Copy';
      } else {
        if (action.kind === 'import') {
          title = 'Import files';
        } else {
          if (action.kind === 'create-file') {
            title = 'New File';
          } else {
            title = 'New Folder';
          }
        }
      }
    }
  }
  let selectionDescription = checkout.root;
  if (action.nativeReferences)
    selectionDescription = `${action.nativeReferences.length} selected item(s) → ${checkout.root}`;
  else if (action.paths.length) selectionDescription = action.paths.join(', ');
  let descriptionSuffix = '';
  if (action.kind === 'trash')
    descriptionSuffix = '. Unsaved text remains in recovery at its original path.';
  else if (action.kind === 'move')
    descriptionSuffix = '. Text and positions are preserved; text undo history resets.';
  async function apply(consent = false) {
    if (busy || (action.kind !== 'trash' && !batchImport && !destination)) return;
    setBusy(true);
    setError('');
    try {
      if (
        controller
          .getSnapshot()
          .operations.some(
            (operation) =>
              operation.clientId === controller.clientId && operation.id === operationId,
          )
      ) {
        const result = await controller.resolveOperation(operationId);
        if (result?.outcome === 'completed') close();
        else
          setError(
            'Operation remains unresolved. Its original identity is retained; no effects were repeated.',
          );
        return;
      }
      const captured =
        sources ?? (action.paths.length ? await controller.inspect(checkout, action.paths) : []);
      setSources(captured);
      let replace = replacements;
      if (action.kind !== 'trash' && replace === null) {
        if (batchImport) {
          const paths = replacementPaths.split('\n').filter(Boolean);
          replace = paths.length ? await controller.inspect(checkout, paths) : [];
        } else {
          const parent = destination.split('/').slice(0, -1).join('/'),
            listing = await controller.list(checkout, parent);
          const collision = listing.entries.find(
            (entry) =>
              entry.path.normalize('NFC').toLowerCase() ===
              destination.normalize('NFC').toLowerCase(),
          );
          replace = collision ? await controller.inspect(checkout, [collision.path]) : [];
        }
        setReplacements(replace);
      }
      if (replace?.length && !consent) return;
      const result = await controller.mutate({
        id: operationId,
        checkout,
        kind: action.kind,
        sources: captured,
        ...(action.kind === 'trash' ? {} : { destination }),
        ...(action.nativeReferences ? { nativeReferences: action.nativeReferences } : {}),
        replacements: replace ?? [],
      });
      if (!active.current || controller.getSnapshot().disposed) return;
      if (result.outcome !== 'completed') {
        setError(
          result.message ?? 'Operation incomplete. Review the recorded outcome before continuing.',
        );
        return;
      }
      if (action.kind === 'create-file')
        await controller.open(
          { checkout, path: destination },
          { view: 'file', intent: 'keep', current: () => active.current },
        );
      close();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Popup
      title={title}
      onClose={() => {
        if (!busy) close();
      }}>
      <Dialog.Description {...stylex.props(styles.path)}>
        {selectionDescription}
        {descriptionSuffix}
      </Dialog.Description>
      {action.kind !== 'trash' && (
        <label {...stylex.props(styles.label)}>
          {batchImport
            ? 'Destination folder (blank for checkout root)'
            : 'Destination relative path'}
          <input
            {...stylex.props(controls.field)}
            autoFocus
            disabled={busy}
            value={destination}
            onChange={(event) => {
              setDestination(event.target.value);
              setReplacements(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) void apply();
            }}
          />
        </label>
      )}
      {batchImport && (
        <label {...stylex.props(styles.label)}>
          Existing destination paths to replace (optional, one per line)
          <textarea
            {...stylex.props(controls.field)}
            disabled={busy}
            value={replacementPaths}
            onChange={(event) => {
              setReplacementPaths(event.target.value);
              setReplacements(null);
            }}
          />
          Only paths matching imported filenames can be replaced; each is captured and confirmed
          before importing.
        </label>
      )}
      {!!replacements?.length && (
        <p role="alert" {...stylex.props(controls.alert)}>
          Replace {replacements.map((item) => item.target.path).join(', ')}? Existing destination
          files will be replaced.
        </p>
      )}
      {error && (
        <p role="alert" {...stylex.props(controls.alert)}>
          {error}
        </p>
      )}
      <div {...stylex.props(styles.dialogActions)}>
        <Button
          {...stylex.props(controls.button)}
          disabled={busy || (action.kind !== 'trash' && !batchImport && !destination)}
          onClick={() => void apply(!!replacements?.length)}>
          {replacements?.length ? 'Replace captured destination' : title}
        </Button>
        <Button {...stylex.props(controls.button)} disabled={busy} onClick={close}>
          Cancel
        </Button>
      </div>
    </Popup>
  );
}

export type EditorWorkbenchHandle = {
  prepareQuit(): Promise<boolean>;
  importFiles(checkout: CheckoutTarget, references: string[]): void;
};
export type EditorWorkbenchProps = {
  controller: EditorController;
  /** Native/user-authorized selection belongs to the shell. A renderer path alone grants no access. */
  selectCheckout?: () => Promise<string | null>;
  selectNativeImports?: (checkout: CheckoutTarget) => Promise<string[]>;
};
export const EditorWorkbench = forwardRef<EditorWorkbenchHandle, EditorWorkbenchProps>(
  function EditorWorkbench({ controller, selectCheckout, selectNativeImports }, ref) {
    const state = useSyncExternalStore(
      controller.subscribe,
      controller.getSnapshot,
      controller.getSnapshot,
    );
    const openCheckouts = state.recovery.checkouts.filter((target) =>
      state.recovery.openCheckoutIds.includes(target.checkoutId),
    );
    const checkout = openCheckouts.find(
      (target) => target.checkoutId === state.recovery.selectedCheckoutId,
    );
    const selected = checkout && readOwn(state.recovery.views, checkout.checkoutId),
      target = checkout && selected?.active ? { checkout, path: selected.active } : undefined;
    const buffer =
      target && state.buffers.find((buffer) => fileKey(buffer.target) === fileKey(target));
    const mode = (target && readOwn(selected?.fileViews, target.path)) || 'file';
    const [lookup, setLookup] = useState(false),
      [panel, setPanel] = useState('files'),
      [action, updateAction] = useState<Action | null>(null);
    const actionRef = useRef<Action | null>(null),
      lookupRef = useRef(lookup);
    useLayoutEffect(() => {
      lookupRef.current = lookup;
    }, [lookup]);
    function setAction(value: Action | null) {
      actionRef.current = value;
      updateAction(value);
    }
    const [choice, setChoice] = useState<{
      file: Readonly<EditorBuffer>;
      resolve: (choice: CloseChoice) => void;
    } | null>(null);
    const pendingChoice = useRef<((choice: CloseChoice) => void) | null>(null);
    const [recent, setRecent] = useState<{
        paths: string[];
        index: number;
        origin: FocusOrigin;
      } | null>(null),
      dragged = useRef<string | null>(null);
    const [focusRequest, setFocusRequest] = useState<{
      checkout: CheckoutTarget;
      path: string;
      origin: FocusOrigin;
    } | null>(null);
    const menuCapture = useRef<string[]>([]),
      root = useRef<HTMLDivElement>(null),
      findFile = useRef<HTMLButtonElement>(null);
    const targetIdentity = target && fileKey(target);
    const targetPath = target?.path;
    const checkoutIdentity = checkout && checkoutKey(checkout);
    useLayoutEffect(() => {
      if (!focusRequest || choice || lookup || action || state.preserving) return;
      if (
        root.current?.getClientRects().length &&
        checkoutIdentity &&
        checkoutIdentity === checkoutKey(focusRequest.checkout) &&
        selected?.active === focusRequest.path
      ) {
        let element: HTMLElement | undefined | null;
        if (focusRequest.origin === 'tree')
          element = root.current.querySelector<HTMLElement>('[role="tree"][aria-label="Files"]');
        else if (targetIdentity) {
          const strip = focusRequest.origin === 'strip';
          const elements = root.current.querySelectorAll<HTMLElement>(
            strip
              ? '[aria-label="Open files"] [role="tab"]'
              : '.monaco-editor textarea[role="textbox"]',
          );
          element = Array.from(elements).find(
            (element) =>
              element.getAttribute('aria-label') === targetPath + (strip ? '' : ' editor'),
          );
        }
        (element ?? findFile.current)?.focus();
      }
      // oxlint-disable-next-line react/set-state-in-effect -- Consume this one-shot DOM focus request after the target has rendered.
      setFocusRequest(null);
    }, [
      focusRequest,
      targetIdentity,
      targetPath,
      checkoutIdentity,
      selected?.active,
      choice,
      lookup,
      action,
      state.preserving,
    ]);
    const withFocus = (opening: Promise<boolean>, origin: FocusOrigin, restore = false) => {
      const focus = () => {
        const next = controller.getSnapshot().recovery;
        if (checkout && next.selectedCheckoutId === checkout.checkoutId)
          setFocusRequest({
            checkout,
            path: readOwn(next.views, checkout.checkoutId)!.active,
            origin,
          });
      };
      return opening.then(
        (success) => {
          if (success || restore) focus();
        },
        (error) => {
          if (restore) focus();
          throw error;
        },
      );
    };
    const choose: ChooseClose = (file) =>
      new Promise((resolve) => {
        pendingChoice.current = resolve;
        setChoice({ file, resolve });
      });
    function answer(value: CloseChoice) {
      pendingChoice.current?.(value);
      pendingChoice.current = null;
      setChoice(null);
    }
    useEffect(
      () => () => {
        pendingChoice.current?.('cancel');
      },
      [],
    );
    const importFiles = useCallback(
      (checkout: CheckoutTarget, references: string[]) => {
        if (!references.length) return;
        const snapshot = controller.getSnapshot();
        if (
          snapshot.preserving ||
          actionRef.current ||
          pendingChoice.current ||
          lookupRef.current
        ) {
          controller.report(
            new Error('Finish the current editor dialog or preservation before importing files.'),
          );
          return;
        }
        if (
          !snapshot.recovery.openCheckoutIds.includes(checkout.checkoutId) ||
          !snapshot.recovery.checkouts.some((item) => checkoutKey(item) === checkoutKey(checkout))
        ) {
          controller.report(new Error('Open the exact import checkout before importing files.'));
          return;
        }
        setAction({
          checkout: { ...checkout },
          kind: 'import',
          paths: [],
          nativeReferences: [...references],
        });
      },
      [controller],
    );
    useImperativeHandle(
      ref,
      () => ({ prepareQuit: () => controller.prepareQuit(choose), importFiles }),
      [controller, importFiles],
    );
    const run = (work: Promise<unknown>) => {
      void work.catch(controller.report);
    };
    async function requestOpen() {
      const root = await selectCheckout?.();
      if (root) await controller.openCheckout(root);
    }
    const selectedPaths = selected?.tree.selected ?? [];
    return (
      <div
        ref={root}
        {...stylex.props(workbench.document, styles.root)}
        aria-label="Moonbase editor"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setRecent(null);
        }}
        onKeyDownCapture={(event) => {
          const element = event.target as HTMLElement;
          if (
            element.closest('[role="dialog"], [role="menu"]') ||
            (element.closest('input,textarea,select,[contenteditable=true]') &&
              !element.closest('.monaco-editor'))
          )
            return;
          if (!checkout || !selected || state.preserving) return;
          const key = event.key.toLowerCase(),
            command = event.metaKey || event.ctrlKey;
          if (command && key === 's') {
            event.preventDefault();
            event.stopPropagation();
            if (target) run(controller.save(target));
          } else if (command && key === 'p' && !event.shiftKey && !event.altKey) {
            event.preventDefault();
            event.stopPropagation();
            setLookup(true);
          } else if (event.metaKey && key === 'w' && !event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            if (target)
              run(withFocus(controller.close([target], choose), focusOrigin(element), true));
          } else if (event.metaKey && event.shiftKey && key === 't') {
            event.preventDefault();
            event.stopPropagation();
            run(withFocus(controller.reopen(checkout), focusOrigin(element), true));
          } else if (
            event.metaKey &&
            event.altKey &&
            ['ArrowLeft', 'ArrowRight'].includes(event.key)
          ) {
            event.preventDefault();
            event.stopPropagation();
            run(
              withFocus(
                controller.navigate(checkout, event.key === 'ArrowRight' ? 1 : -1),
                focusOrigin(element),
              ),
            );
          } else if (event.ctrlKey && event.key === 'Tab') {
            event.preventDefault();
            event.stopPropagation();
            const paths =
              recent?.paths ??
              [
                ...new Set([
                  selected.active,
                  ...state.recovery.recentFiles
                    .filter((file) => checkoutKey(file.checkout) === checkoutKey(checkout))
                    .map((file) => file.path),
                  ...selected.openFiles,
                ]),
              ].filter((path) => selected.openFiles.includes(path));
            if (paths.length)
              setRecent({
                paths,
                index:
                  ((recent?.index ?? 0) + (event.shiftKey ? paths.length - 1 : 1)) % paths.length,
                origin: recent?.origin ?? focusOrigin(element),
              });
          } else if (event.key === 'Escape' && recent) {
            event.preventDefault();
            setRecent(null);
          }
        }}
        onKeyUp={(event) => {
          if (event.key === 'Control' && recent && checkout) {
            const path = recent.paths[recent.index];
            setRecent(null);
            run(withFocus(controller.open({ checkout, path }), recent.origin));
          }
        }}>
        <Tabs.Root
          value={checkout?.checkoutId ?? ''}
          onValueChange={(value) => {
            const target = openCheckouts.find((item) => item.checkoutId === value);
            if (target) run(controller.selectCheckout(target));
          }}
          {...stylex.props(styles.panel)}>
          <Tabs.List
            {...stylex.props(workbench.projectTabs, styles.checkoutTabs)}
            aria-label="Checkouts">
            {openCheckouts.map((item) => (
              <div key={checkoutKey(item)} {...stylex.props(workbench.fileTab)}>
                <Tabs.Tab
                  value={item.checkoutId}
                  title={`${item.hostId} · ${item.branch} · ${item.root}`}
                  {...stylex.props(
                    controls.button,
                    checkout?.checkoutId === item.checkoutId && workbench.fileSelected,
                  )}>
                  {item.root.split('/').at(-1)} · {item.branch}
                </Tabs.Tab>
                <Button
                  {...stylex.props(controls.button)}
                  aria-label={`Close checkout ${item.root}`}
                  disabled={state.preserving}
                  onClick={() => run(controller.closeCheckout(item, choose))}>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 16 16"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    aria-hidden="true">
                    <path d="m4 4 8 8 M12 4l-8 8" />
                  </svg>
                </Button>
              </div>
            ))}
            {selectCheckout && (
              <Button {...stylex.props(controls.button)} onClick={() => run(requestOpen())}>
                Open checkout
              </Button>
            )}
          </Tabs.List>
          {!state.ready && (
            <p role="status" {...stylex.props(styles.empty)}>
              Load editor recovery before opening a checkout.
            </p>
          )}
          {!checkout && state.ready && (
            <p {...stylex.props(styles.empty)}>
              Open a checkout to browse files and edit. Unsaved changes belong to this editor
              instance.
            </p>
          )}
          {checkout && selected && (
            <Tabs.Panel value={checkout.checkoutId} {...stylex.props(styles.tabPanel)}>
              <div {...stylex.props(workbench.sidebarLayout(state.recovery.sidebarWidth))}>
                <div {...stylex.props(workbench.workspace)}>
                  <div
                    role="separator"
                    tabIndex={0}
                    aria-label="Resize sidebar"
                    aria-orientation="vertical"
                    aria-valuemin={190}
                    aria-valuemax={380}
                    aria-valuenow={state.recovery.sidebarWidth}
                    {...stylex.props(workbench.sidebarResize)}
                    onKeyDown={(event) => {
                      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                        event.preventDefault();
                        let width =
                          state.recovery.sidebarWidth + (event.key === 'ArrowRight' ? 10 : -10);
                        if (event.key === 'Home') width = 190;
                        else if (event.key === 'End') width = 380;
                        controller.resizeSidebar(width);
                      }
                    }}
                    onPointerDown={(event) => {
                      if (event.button === 0)
                        event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      if (event.currentTarget.hasPointerCapture(event.pointerId))
                        controller.resizeSidebar(
                          event.clientX -
                            event.currentTarget.parentElement!.getBoundingClientRect().left,
                        );
                    }}
                    onPointerUp={(event) => {
                      if (event.currentTarget.hasPointerCapture(event.pointerId))
                        event.currentTarget.releasePointerCapture(event.pointerId);
                    }}
                  />
                  <aside {...stylex.props(workbench.sidebar)} aria-label="Editor sidebar">
                    <div {...stylex.props(filesUI.tools)}>
                      <Button
                        {...stylex.props(controls.button)}
                        aria-pressed={panel === 'files'}
                        onClick={() => setPanel('files')}>
                        Files
                      </Button>
                      <Button
                        {...stylex.props(controls.button)}
                        aria-pressed={panel === 'git'}
                        onClick={() => setPanel('git')}>
                        Diff
                      </Button>
                      <Button
                        ref={findFile}
                        {...stylex.props(controls.button)}
                        onClick={() => setLookup(true)}>
                        Find file
                      </Button>
                    </div>
                    <p {...stylex.props(workbench.directory)}>
                      {checkout.branch} · {checkout.root}
                    </p>
                    <Button
                      {...stylex.props(controls.button)}
                      onClick={() => run(controller.refresh(checkout))}>
                      Refresh
                    </Button>
                    {panel === 'files' ? (
                      <>
                        <div {...stylex.props(filesUI.tools)}>
                          {(['create-file', 'create-directory'] as const).map((kind) => (
                            <Button
                              key={kind}
                              {...stylex.props(controls.button)}
                              disabled={state.preserving}
                              onClick={() =>
                                setAction({ checkout: { ...checkout }, kind, paths: [] })
                              }>
                              {kind === 'create-file' ? 'New File' : 'New Folder'}
                            </Button>
                          ))}
                        </div>
                        <Button
                          {...stylex.props(controls.button)}
                          aria-pressed={selected.tree.hideIgnored}
                          onClick={() => {
                            controller.tree(checkout, { hideIgnored: !selected.tree.hideIgnored });
                            run(controller.refresh(checkout));
                          }}>
                          Hide Git-ignored files
                        </Button>
                        <Button
                          {...stylex.props(controls.button)}
                          disabled={!target}
                          onClick={() => {
                            if (target) run(controller.reveal(target));
                          }}>
                          Reveal Active File
                        </Button>
                        <FilesTree
                          controller={controller}
                          state={state}
                          checkout={checkout}
                          active={selected.active}
                        />
                        <div {...stylex.props(filesUI.tools)}>
                          {(['move', 'copy', 'trash'] as const).map((kind) => (
                            <Button
                              key={kind}
                              {...stylex.props(controls.button)}
                              disabled={
                                state.preserving ||
                                !selectedPaths.length ||
                                (kind !== 'trash' && selectedPaths.length !== 1)
                              }
                              onClick={() =>
                                setAction({
                                  checkout: { ...checkout },
                                  kind,
                                  paths: [...selectedPaths],
                                })
                              }>
                              {{ move: 'Rename / Move', trash: 'Trash', copy: 'Copy' }[kind]}
                            </Button>
                          ))}
                        </div>
                        {selectNativeImports && (
                          <Button
                            {...stylex.props(controls.button)}
                            disabled={state.preserving}
                            onClick={() =>
                              run(
                                (async () => {
                                  const target = { ...checkout };
                                  importFiles(target, await selectNativeImports(target));
                                })(),
                              )
                            }>
                            Import files
                          </Button>
                        )}
                      </>
                    ) : (
                      <>
                        {state.git[checkoutKey(checkout)]?.error && (
                          <p role="status" {...stylex.props(controls.alert)}>
                            {state.git[checkoutKey(checkout)].error}
                          </p>
                        )}
                        {(['staged', 'unstaged', 'untracked'] as const).map((area) => (
                          <section key={area}>
                            <h2 {...stylex.props(controls.heading)}>{area}</h2>
                            <ul {...stylex.props(controls.list)}>
                              {state.git[checkoutKey(checkout)]?.changes
                                .filter((change) => change.area === area)
                                .map((change) => (
                                  <li key={change.path}>
                                    <Button
                                      {...stylex.props(controls.button, controls.listButton)}
                                      onClick={() =>
                                        run(
                                          controller.open(
                                            { checkout, path: change.path },
                                            { view: area, intent: 'preview' },
                                          ),
                                        )
                                      }>
                                      {change.path}
                                    </Button>
                                  </li>
                                ))}
                            </ul>
                          </section>
                        ))}
                      </>
                    )}
                  </aside>
                  <section {...stylex.props(workbench.content)} aria-label="Main editor">
                    <Tabs.Root
                      value={selected.active}
                      onValueChange={(value) =>
                        run(controller.open({ checkout, path: String(value) }))
                      }
                      {...stylex.props(styles.panel)}>
                      <Tabs.List aria-label="Open files" {...stylex.props(workbench.fileTabs)}>
                        {selected.openFiles.map((path) => {
                          const file = { checkout, path },
                            current = state.buffers.find(
                              (buffer) => fileKey(buffer.target) === fileKey(file),
                            ),
                            dirty = current && current.text !== current.disk.text;
                          const parts = path.split('/');
                          let label = parts.at(-1)!;
                          for (let count = 1; count <= parts.length; count++) {
                            label = parts.slice(-count).join('/');
                            if (
                              !selected.openFiles.some(
                                (other) =>
                                  other !== path &&
                                  other.split('/').slice(-count).join('/') === label,
                              )
                            )
                              break;
                          }
                          return (
                            <span
                              key={path}
                              {...stylex.props(workbench.fileTab)}
                              onDragOver={(event) => {
                                if (dragged.current) event.preventDefault();
                              }}
                              onDrop={(event) => {
                                event.preventDefault();
                                if (dragged.current)
                                  controller.reorder(
                                    checkout,
                                    dragged.current,
                                    selected.openFiles.indexOf(path),
                                  );
                                dragged.current = null;
                              }}>
                              <Tabs.Tab
                                value={path}
                                aria-label={path}
                                title={`${checkout.hostId} · ${checkout.root}/${path}`}
                                aria-description={
                                  [selected.preview === path && 'Preview', dirty && 'Unsaved']
                                    .filter(Boolean)
                                    .join(', ') || undefined
                                }
                                draggable={!state.preserving}
                                onDragStart={(event) => {
                                  dragged.current = path;
                                  event.dataTransfer.setData('text/plain', path);
                                }}
                                onDragEnd={() => {
                                  dragged.current = null;
                                }}
                                onDoubleClick={() => controller.keepOpen(file)}
                                {...stylex.props(
                                  controls.button,
                                  workbench.fileTabButton,
                                  selected.active === path && workbench.fileSelected,
                                  selected.preview === path && workbench.preview,
                                  dirty && workbench.unsaved,
                                )}>
                                {label}
                              </Tabs.Tab>
                              <Button
                                {...stylex.props(controls.button)}
                                aria-label={`Close ${path}`}
                                disabled={state.preserving}
                                onClick={() => run(controller.close([file], choose))}>
                                <svg
                                  width="12"
                                  height="12"
                                  viewBox="0 0 16 16"
                                  stroke="currentColor"
                                  strokeWidth="1.5"
                                  aria-hidden="true">
                                  <path d="m4 4 8 8 M12 4l-8 8" />
                                </svg>
                              </Button>
                            </span>
                          );
                        })}
                      </Tabs.List>
                      <div {...stylex.props(workbench.toolbar)}>
                        <span {...stylex.props(workbench.toolbarLabel)}>
                          {selected.active || 'No file selected'}
                          {buffer && buffer.text !== buffer.disk.text ? ' · Unsaved' : ''}
                        </span>
                        {target && (
                          <>
                            <label>
                              File view{' '}
                              <select
                                aria-label="File view"
                                {...stylex.props(controls.field)}
                                value={mode}
                                onChange={(event) =>
                                  run(
                                    controller.open(target, {
                                      view: event.target.value as FileView,
                                    }),
                                  )
                                }>
                                <option value="file">File</option>
                                {(['staged', 'unstaged', 'untracked'] as const).map((mode) => (
                                  <option key={mode} value={mode}>
                                    {mode}
                                  </option>
                                ))}
                                {(buffer?.conflict || mode === 'conflict') && (
                                  <option value="conflict">Save conflict</option>
                                )}
                              </select>
                            </label>
                            <Button
                              {...stylex.props(controls.button)}
                              disabled={!buffer || buffer.saving || state.preserving}
                              onClick={() => run(controller.save(target))}>
                              {buffer?.pendingSave ? 'Retry Save' : 'Save'}
                            </Button>
                            {selected.preview === target.path && (
                              <Button
                                {...stylex.props(controls.button)}
                                onClick={() => controller.keepOpen(target)}>
                                Keep Open
                              </Button>
                            )}
                          </>
                        )}
                        <Menu.Root
                          onOpenChange={(open) => {
                            if (open) menuCapture.current = [...selected.openFiles];
                          }}>
                          <Menu.Trigger {...stylex.props(controls.button)}>
                            Tab actions
                          </Menu.Trigger>
                          <Menu.Portal>
                            <Menu.Positioner>
                              <Menu.Popup {...stylex.props(overlays.popup, overlays.options)}>
                                {target && (
                                  <>
                                    <Menu.Item
                                      {...stylex.props(overlays.option)}
                                      onClick={() => controller.keepOpen(target)}>
                                      Keep Open
                                    </Menu.Item>
                                    {(
                                      [
                                        'Close',
                                        'Close Others',
                                        'Close to the Right',
                                        'Close All',
                                      ] as const
                                    ).map((label) => (
                                      <Menu.Item
                                        key={label}
                                        {...stylex.props(overlays.option)}
                                        onClick={() => {
                                          let paths;
                                          if (label === 'Close') {
                                            paths = [target.path];
                                          } else {
                                            if (label === 'Close Others') {
                                              paths = menuCapture.current.filter(
                                                (path) => path !== target.path,
                                              );
                                            } else {
                                              if (label === 'Close to the Right') {
                                                paths = menuCapture.current.slice(
                                                  menuCapture.current.indexOf(target.path) + 1,
                                                );
                                              } else {
                                                paths = menuCapture.current;
                                              }
                                            }
                                          }
                                          run(
                                            controller.close(
                                              paths.map((path) => ({ checkout, path })),
                                              choose,
                                            ),
                                          );
                                        }}>
                                        {label}
                                      </Menu.Item>
                                    ))}
                                    <Menu.Item
                                      {...stylex.props(overlays.option)}
                                      onClick={() =>
                                        controller.reorder(
                                          checkout,
                                          target.path,
                                          selected.openFiles.indexOf(target.path) - 1,
                                        )
                                      }>
                                      Move tab left
                                    </Menu.Item>
                                    <Menu.Item
                                      {...stylex.props(overlays.option)}
                                      onClick={() =>
                                        controller.reorder(
                                          checkout,
                                          target.path,
                                          selected.openFiles.indexOf(target.path) + 1,
                                        )
                                      }>
                                      Move tab right
                                    </Menu.Item>
                                  </>
                                )}
                                <Menu.Item
                                  {...stylex.props(overlays.option)}
                                  onClick={() => run(controller.reopen(checkout))}>
                                  Reopen Closed Files
                                </Menu.Item>
                              </Menu.Popup>
                            </Menu.Positioner>
                          </Menu.Portal>
                        </Menu.Root>
                      </div>
                      {buffer?.conflict && target && (
                        <div role="alert" {...stylex.props(controls.alert, workbench.conflict)}>
                          <p>{target.path} changed on disk. Your edits are retained.</p>
                          <div {...stylex.props(styles.toolbar)}>
                            <Button
                              {...stylex.props(controls.button)}
                              onClick={() => run(controller.open(target, { view: 'conflict' }))}>
                              Compare
                            </Button>
                            <Button
                              {...stylex.props(controls.button)}
                              onClick={() => run(controller.save(target, true))}>
                              Overwrite observed version
                            </Button>
                            <Button
                              {...stylex.props(controls.button)}
                              onClick={() => run(controller.reload(target))}>
                              Reload
                            </Button>
                            <Button
                              {...stylex.props(controls.button)}
                              onClick={() => controller.cancelConflict(target)}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      )}
                      {!target && (
                        <p {...stylex.props(styles.empty)}>
                          Choose a file from Files or Find file. Save writes explicitly; typing
                          retains a recovery draft.
                        </p>
                      )}
                      {target && !buffer && !state.comparisons[fileKey(target)] && (
                        <p role="status" {...stylex.props(controls.alert)}>
                          File unavailable; retained tab and recovery references remain.{' '}
                          <Button
                            {...stylex.props(controls.button)}
                            onClick={() => run(controller.open(target))}>
                            Retry file
                          </Button>
                        </p>
                      )}
                      <MonacoView
                        controller={controller}
                        state={state}
                        target={target}
                        mode={mode}
                      />
                    </Tabs.Root>
                  </section>
                </div>
              </div>
            </Tabs.Panel>
          )}
        </Tabs.Root>
        {!!state.errors.length && (
          <div role="alert" {...stylex.props(controls.status, controls.alert)}>
            {state.errors.at(-1)}{' '}
            <Button {...stylex.props(controls.button)} onClick={() => controller.clearErrors()}>
              Dismiss error
            </Button>
          </div>
        )}
        {state.publication && (
          <p role="status" {...stylex.props(controls.status)}>
            Recovery publication PENDING/UNCERTAIN ({state.publication.kind}):{' '}
            {state.publication.requestId}. Live work is retained.
            <Button
              {...stylex.props(controls.button)}
              onClick={() =>
                run(
                  withFocus(
                    controller.resolveRecoveryPublication(),
                    focusRequest?.origin ?? 'editor',
                    true,
                  ),
                )
              }>
              Resolve recovery publication
            </Button>
          </p>
        )}
        {state.operations.map((operation) => (
          <p
            key={JSON.stringify([operation.clientId, operation.id])}
            role="status"
            {...stylex.props(controls.status)}>
            {operation.kind}: {operation.outcome}. {operation.message}
            <Button
              {...stylex.props(controls.button)}
              onClick={() => run(controller.resolveOperation(operation.id, operation.clientId))}>
              Resolve operation status
            </Button>
          </p>
        ))}
        {lookup && checkout && (
          <FileLookup
            controller={controller}
            state={state}
            checkout={checkout}
            close={() => setLookup(false)}
            editorFocus={() =>
              root.current?.querySelector<HTMLElement>('.monaco-editor textarea[role="textbox"]') ??
              null
            }
          />
        )}
        {action && (
          <Mutation controller={controller} action={action} close={() => setAction(null)} />
        )}
        {choice && (
          <Popup title="Save changes before closing?" onClose={() => answer('cancel')}>
            <Dialog.Description>{choice.file.target.path} has unsaved changes.</Dialog.Description>
            <div {...stylex.props(styles.dialogActions)}>
              {(['save', 'discard', 'cancel'] as const).map((value) => (
                <Button
                  key={value}
                  {...stylex.props(controls.button)}
                  onClick={() => answer(value)}>
                  {value[0].toUpperCase() + value.slice(1)}
                </Button>
              ))}
            </div>
          </Popup>
        )}
        {recent && (
          <div role="listbox" aria-label="Recent tabs" {...stylex.props(overlays.recent)}>
            {recent.paths.map((path, index) => (
              <div
                key={path}
                role="option"
                aria-selected={recent.index === index}
                {...stylex.props(
                  overlays.recentOption,
                  recent.index === index && workbench.fileSelected,
                )}>
                {path}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  },
);
