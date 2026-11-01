import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { styles } from './styles.ts';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@base-ui/react/button';
import { Dialog } from '@base-ui/react/dialog';
import type {
  CheckoutTarget,
  EntryReference,
  WorkspaceOperation,
} from '@moonbase/application/client';
import type { EditorController } from './editor.ts';
import { Popup } from './popup.tsx';

export type Action = {
  checkout: CheckoutTarget;
  kind: WorkspaceOperation['kind'];
  paths: string[];
  nativeReferences?: string[];
};
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
