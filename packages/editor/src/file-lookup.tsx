import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { styles } from './styles.ts';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@base-ui/react/button';
import { Dialog } from '@base-ui/react/dialog';
import { overlays } from '@moonbase/ui/overlays';
import type { CheckoutTarget, LookupMatch } from '@moonbase/application/client';
import { checkoutKey, fileKey, type EditorController, type EditorSnapshot } from './editor.ts';
import { Popup } from './popup.tsx';

export function FileLookup({
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
  useEffect(() => {
    const requestCounter = request;
    active.current = true;
    return () => {
      active.current = false;
      requestCounter.current++;
    };
  }, []);
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
