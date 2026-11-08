import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { styles } from './styles.ts';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button } from '@base-ui/react/button';
import { Dialog } from '@base-ui/react/dialog';
import { Popup } from './popup.tsx';

export type { MutationAction as Action } from '@moonbase/application/editor';
import type {
  EditorController,
  EditorMutation,
  MutationAction as Action,
} from '@moonbase/application/editor';
import { checkoutKey } from '@moonbase/application/editor';
const empty = { busy: false, error: '', replacements: null };
const emptySnapshot = () => empty;
const noSubscription = () => () => {};

/**
 * The dialog for Move to Trash and Import, which need a confirmation or a destination; the tree
 * runs its other file operations directly (see `mutation-runner.tsx`).
 */
export function Mutation({
  controller,
  action,
  close,
  finalFocus,
}: {
  controller: EditorController;
  action: Action;
  close: () => void;
  finalFocus?: () => boolean | HTMLElement | null;
}) {
  const checkout = action.checkout,
    batchImport = action.kind === 'import' && action.nativeReferences!.length > 1;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const unavailable =
    state.disposed ||
    !state.recovery.openCheckoutIds.includes(checkout.checkoutId) ||
    !state.recovery.checkouts.some((target) => checkoutKey(target) === checkoutKey(checkout));
  const [destination, setDestination] = useState('');
  const [replacementPaths, setReplacementPaths] = useState('');
  const [workflow, setWorkflow] = useState<EditorMutation | null>(null);
  const { replacements, busy, error } = useSyncExternalStore(
    workflow?.subscribe ?? noSubscription,
    workflow?.getSnapshot ?? emptySnapshot,
  );
  useEffect(() => {
    const acquired = controller.createMutation(action);
    // oxlint-disable-next-line react/set-state-in-effect -- The model owns a fresh dialog attachment, including StrictMode remounts.
    setWorkflow(acquired);
    return () => {
      void acquired.dispose().catch(controller.report);
    };
  }, [controller, action]);
  const title = action.kind === 'trash' ? 'Move to Trash' : 'Import files';
  let selectionDescription = action.paths.join(', ');
  if (action.nativeReferences)
    selectionDescription = `${action.nativeReferences.length} selected item(s)`;
  const descriptionSuffix =
    action.kind === 'trash' ? '. Unsaved text remains in recovery at its original path.' : '';
  async function apply(consent = false) {
    if (unavailable || busy || (action.kind !== 'trash' && !batchImport && !destination)) return;
    if (await workflow?.apply(destination, replacementPaths, consent)) close();
  }
  return (
    <Popup
      title={title}
      finalFocus={finalFocus}
      onClose={() => {
        if (!busy) close();
      }}>
      <Dialog.Description {...stylex.props(styles.path)}>
        {checkout.hostId} · {checkout.root}
        {selectionDescription && ' — '}
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
              workflow?.invalidate();
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
              workflow?.invalidate();
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
      {unavailable && (
        <p role="alert" {...stylex.props(controls.alert)}>
          The captured checkout is unavailable. Reopen that exact checkout before continuing.
        </p>
      )}
      <div {...stylex.props(styles.dialogActions)}>
        <Button
          {...stylex.props(controls.button)}
          disabled={
            unavailable || busy || (action.kind !== 'trash' && !batchImport && !destination)
          }
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
