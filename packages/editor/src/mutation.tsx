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
const empty = { busy: false, error: '', replacements: null };
const emptySnapshot = () => empty;
const noSubscription = () => () => {};

export function Mutation({
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
  );
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
  const titles: Record<Action['kind'], string> = {
    trash: 'Move to Trash',
    move: 'Rename or move',
    copy: 'Copy',
    import: 'Import files',
    'create-file': 'New File',
    'create-directory': 'New Folder',
  };
  const title = titles[action.kind];
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
    if (await workflow?.apply(destination, replacementPaths, consent)) {
      if (action.kind === 'create-file')
        await controller.open({ checkout, path: destination }, { view: 'file', intent: 'keep' });
      close();
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
