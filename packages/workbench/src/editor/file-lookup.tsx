import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { styles } from './styles.ts';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@base-ui/react/button';
import { Dialog } from '@base-ui/react/dialog';
import { overlays } from '@moonbase/ui/overlays';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import {
  checkoutKey,
  fileKey,
  type EditorController,
  type EditorSnapshot,
} from '@moonbase/application/editor';
import type { EditorLookup } from '@moonbase/application/editor';
import { Popup } from './popup.tsx';

const empty = { rows: [], message: 'Type a filename or path.', busy: false };
const emptySnapshot = () => empty;
const noSubscription = () => () => {};

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
  const [lookup, setLookup] = useState<EditorLookup | null>(null);
  const { rows, message, busy } = useSyncExternalStore(
    lookup?.subscribe ?? noSubscription,
    lookup?.getSnapshot ?? emptySnapshot,
  );
  const [index, setIndex] = useState(0);
  const activated = useRef(false),
    id = useId();
  const scope = all
      ? state.recovery.checkouts.filter((target) =>
          state.recovery.openCheckoutIds.includes(target.checkoutId),
        )
      : [checkout],
    scopeKey = JSON.stringify(scope);
  useEffect(() => {
    const acquired = controller.createLookup();
    // oxlint-disable-next-line react/set-state-in-effect -- React owns this popup attachment; the model owns its async work.
    setLookup(acquired);
    return () => {
      void acquired.dispose().catch(controller.report);
    };
  }, [controller]);
  useEffect(() => {
    lookup?.query(query, JSON.parse(scopeKey));
    // oxlint-disable-next-line react/set-state-in-effect -- Reset keyboard selection when model query inputs change.
    setIndex(0);
  }, [query, scopeKey, refresh, lookup, state.discoveryRevision]);
  async function open(row = rows[index]) {
    if (!row && all) {
      lookup?.message('Choose one exact checkout result, or search in the active checkout.');
      return;
    }
    const target = row ? { checkout: row.checkout, path: row.path } : { checkout, path: query };
    if (
      await lookup?.open((current) =>
        controller.open(target, {
          view: 'file',
          intent: 'keep',
          current: () =>
            current() &&
            controller
              .getSnapshot()
              .recovery.openCheckoutIds.includes(target.checkout.checkoutId) &&
            controller
              .getSnapshot()
              .recovery.checkouts.some(
                (item) => checkoutKey(item) === checkoutKey(target.checkout),
              ),
        }),
      )
    ) {
      activated.current = true;
      close();
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
          role="combobox"
          aria-controls={id}
          aria-expanded={rows.length > 0}
          aria-activedescendant={rows[index] ? `${id}-${index}` : undefined}
          onChange={(event) => {
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
