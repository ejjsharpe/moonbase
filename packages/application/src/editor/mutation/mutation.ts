import type {
  CheckoutTarget,
  DirectoryEntry,
  EntryReference,
  OperationResult,
  WorkspaceOperation,
} from '@moonbase/contracts/workspace';
import type { EditorRecovery } from '../recovery/recovery-layout.ts';
import { isCheckoutOpen } from '../views/views.ts';

/** A file operation as the tree, a dialog or a drop asks for it. */
export type MutationAction = {
  checkout: CheckoutTarget;
  kind: WorkspaceOperation['kind'];
  paths: string[];
  nativeReferences?: string[];
  /**
   * The names `nativeReferences` import as, in order, when the caller knows them, such as dropped
   * files'. A batch import then finds the existing entries it would replace in its destination
   * folder, rather than taking them as typed paths. The workspace still checks each replacement
   * against the actual source names, so a wrong name replaces nothing.
   */
  nativeNames?: string[];
};
/** Where a mutation goes and how it identifies itself. */
export type MutationOptions = {
  /** The destination path, or folder for a batch; unused for Trash. */
  destination: string;
  /** For a batch import without `nativeNames`: typed paths it may replace, one per line. */
  replacementPaths?: string;
  /**
   * The operation's ID. A dialog keeps one for its lifetime, so applying again after an outcome
   * was lost resolves that operation rather than running it twice.
   */
  id?: string;
};
/**
 * How a mutation ended: done, declined (or ended by disposal) without an error, or failed.
 * `items` are the dispatched operation's per-entry outcomes, empty when none was dispatched; a
 * batch that failed partway lists the entries it did complete.
 */
export type MutationRunResult = {
  completed: boolean;
  error: string;
  items: OperationResult['items'];
};
/** A running mutation asks before it replaces these existing entries. */
export type ReplacePrompt = { id: string; paths: string[] };
/** The mutation fields of the editor's snapshot. */
export type MutationState = {
  /** Whether a mutation is running, including while it asks. */
  mutating: boolean;
  replacePrompt: ReplacePrompt | null;
};

/** The most entries one move or copy takes. */
export const maxMutationEntries = 128;
/** Why the mutation gate refused an action. */
export const mutationUnavailable =
  'File action unavailable. Check the selection and finish the current editor dialog or Close prompt.';

/** The mutation gate: the editor is ready and idle, the checkout is open and the action fits. */
export function admitsMutation(
  editor: {
    ready: boolean;
    closing: boolean;
    holdingUnsaved: boolean;
    prompting: boolean;
    mutating: boolean;
    recovery: EditorRecovery;
  },
  action: MutationAction,
) {
  return (
    editor.ready &&
    !editor.closing &&
    !editor.holdingUnsaved &&
    !editor.prompting &&
    !editor.mutating &&
    isCheckoutOpen(editor.recovery, action.checkout) &&
    // Several entries move or copy into one folder, as a drag from the tree does.
    (!(action.kind === 'move' || action.kind === 'copy') ||
      (action.paths.length >= 1 && action.paths.length <= maxMutationEntries)) &&
    (action.kind !== 'trash' || action.paths.length > 0)
  );
}

/** Where each source lands: in a batch's destination folder (maybe the root), or at one path. */
export function getMutationDestinations(sources: readonly EntryReference[], destination: string) {
  const batch = sources.length > 1;
  return {
    parent: batch ? destination : destination.split('/').slice(0, -1).join('/'),
    destinations: batch
      ? sources.map((source) =>
          [destination, source.target.path.split('/').at(-1)].filter(Boolean).join('/'),
        )
      : [destination],
  };
}

/**
 * The paths an operation writes: each entry's path in a batch's destination folder (which may be
 * the root), or one destination path.
 */
export function listOperationDestinations(operation: WorkspaceOperation) {
  if (operation.destination === undefined) return [];
  if (operation.sources.length > 1)
    return getMutationDestinations(operation.sources, operation.destination).destinations;
  return operation.destination ? [operation.destination] : [];
}

const folded = (path: string) => path.normalize('NFC').toLowerCase();

/**
 * The listed entries a mutation would replace: those at its destinations, matched without regard
 * to case or normalization, except a move onto its own entry, which only renames it. `own` is
 * whether one of them is a source itself, which a copy refuses.
 */
export function findCollisions(
  entries: readonly DirectoryEntry[],
  destinations: readonly string[],
  sources: readonly EntryReference[],
  kind: WorkspaceOperation['kind'],
) {
  const matching = new Set(destinations.map(folded));
  const sourcePaths = new Set(sources.map((source) => source.target.path));
  const collisions = entries.filter(
    (entry) =>
      matching.has(folded(entry.path)) && !(kind === 'move' && sourcePaths.has(entry.path)),
  );
  return { collisions, own: collisions.some((entry) => sourcePaths.has(entry.path)) };
}
