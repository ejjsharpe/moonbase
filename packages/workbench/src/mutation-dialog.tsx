import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { useState } from 'react';
import { useAtomValue } from '@effect/atom-react';
import { Button } from '@base-ui/react/button';
import { Effect } from 'effect';
import { Dialog } from '@base-ui/react/dialog';
import { Popup, popupStyles } from './popup.tsx';
import { space } from '@moonbase/ui/tokens.stylex';

export type { MutationAction as Action } from '@moonbase/application/editor';
import type { MutationAction as Action } from '@moonbase/application/editor';
import { checkoutKey } from '@moonbase/application/editor';
import type { EditorActions } from './editor-actions.ts';
import { usePendingEditorTask } from './use-editor-task.ts';

/**
 * The dialog for Move to Trash and Import, which need a confirmation or a destination; the tree
 * runs its other file operations directly (see `mutation-runner.tsx`).
 */
export function Mutation({
  actions,
  action,
  close,
  finalFocus,
  onApplied,
}: {
  actions: EditorActions;
  action: Action;
  close: () => void;
  finalFocus?: () => boolean | HTMLElement | null;
  /** Called once applying it may have changed files: it ran, or failed, rather than asking. */
  onApplied?: () => void;
}) {
  const checkout = action.checkout,
    batchImport = action.kind === 'import' && action.nativeReferences!.length > 1;
  const disposed = useAtomValue(actions.atoms.session.disposed),
    known = useAtomValue(actions.atoms.views.checkouts);
  const unavailable =
    disposed ||
    !known.openCheckoutIds.includes(checkout.checkoutId) ||
    !known.checkouts.some((target) => checkoutKey(target) === checkoutKey(checkout));
  const [destination, setDestination] = useState('');
  const [replacementPaths, setReplacementPaths] = useState('');
  const [busy, run] = usePendingEditorTask(actions);
  const [error, setError] = useState('');
  // One operation per dialog: applying again after its outcome was lost resolves it, never
  // repeats it.
  const [id] = useState(() => crypto.randomUUID());
  const title = action.kind === 'trash' ? 'Move to Trash' : 'Import files';
  let selectionDescription = action.paths.join(', ');
  if (action.nativeReferences)
    selectionDescription = `${action.nativeReferences.length} selected item(s)`;
  const descriptionSuffix =
    action.kind === 'trash' ? '. Unsaved text remains in recovery at its original path.' : '';
  function apply() {
    if (unavailable || busy || (action.kind !== 'trash' && !batchImport && !destination)) return;
    setError('');
    run(
      Effect.gen(function* () {
        // Replacing existing entries is confirmed through the editor's replace prompt.
        const result = yield* actions.mutate(action, { destination, replacementPaths, id });
        setError(result.error);
        if (result.completed || result.error || result.items.length) onApplied?.();
        if (result.completed) close();
      }),
    );
  }
  return (
    <Popup
      title={title}
      finalFocus={finalFocus}
      onClose={() => {
        if (!busy) close();
      }}>
      <Dialog.Description {...stylex.props(popupStyles.path)}>
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
            }}
          />
          Only paths matching imported filenames can be replaced; each is captured and confirmed
          before importing.
        </label>
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
      <div {...stylex.props(popupStyles.actions)}>
        <Button
          {...stylex.props(controls.button)}
          disabled={
            unavailable || busy || (action.kind !== 'trash' && !batchImport && !destination)
          }
          onClick={() => void apply()}>
          {title}
        </Button>
        <Button {...stylex.props(controls.button)} disabled={busy} onClick={close}>
          Cancel
        </Button>
      </div>
    </Popup>
  );
}

const styles = stylex.create({
  label: { display: 'flex', flexDirection: 'column', gap: space.xs, marginBottom: space.md },
});
