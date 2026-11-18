import { Layer } from 'effect';
import { EditorSession } from './session/session-service.ts';
import { EditorAlerts } from './alerts/alerts-service.ts';
import { EditorViews } from './views/views-service.ts';
import { EditorOperations } from './operations/operations-service.ts';
import { RecoveryOutbox } from './recovery/recovery-outbox-service.ts';
import { EditorDiscovery } from './discovery/discovery-service.ts';
import { EditorBuffers } from './buffers/buffers-service.ts';
import { RecoverySync } from './recovery/recovery-sync-service.ts';
import { EditorTabs } from './tabs/tabs-service.ts';
import { EditorTree } from './tree/tree-service.ts';
import { EditorMutations } from './mutation/mutation-service.ts';
import { EditorSaves } from './saves/saves-service.ts';
import { UnsavedChangesGuard } from './unsaved-changes/unsaved-changes-service.ts';
import { EditorCheckouts } from './checkouts/checkouts-service.ts';
import { EditorLookup } from './lookup/lookup-service.ts';
import { EditorTextSearch } from './text-search/text-search-service.ts';
import { EditorWorktrees } from './worktrees/worktrees-service.ts';
import { EditorLoader } from './editor-loader.ts';

export type EditorOptions = {
  /** The recovery namespace; a fresh one when absent. */
  clientId?: string;
  /** Backoff before each re-watch of a checkout; its length caps the attempts. */
  watchRetryMs?: readonly number[];
};

/** Every service one editor is made of. */
export type EditorServices =
  | EditorSession
  | EditorAlerts
  | EditorViews
  | EditorOperations
  | RecoveryOutbox
  | EditorDiscovery
  | EditorBuffers
  | RecoverySync
  | EditorTabs
  | EditorTree
  | EditorMutations
  | EditorSaves
  | UnsavedChangesGuard
  | EditorCheckouts
  | EditorLookup
  | EditorTextSearch
  | EditorWorktrees
  | EditorLoader;

/**
 * One editor over the `WorkspaceService` its root supplies. Closing the layer's scope stops it
 * first (nothing is admitted, reported or sent), then releases each service in reverse.
 */
export const editorLayer = (options: EditorOptions = {}) => {
  const base = Layer.provideMerge(EditorAlerts.layer, EditorSession.layer(options));
  const state = Layer.provideMerge(
    EditorOperations.layer,
    Layer.provideMerge(Layer.mergeAll(EditorViews.layer, RecoveryOutbox.layer), base),
  );
  const discovery = Layer.provideMerge(EditorDiscovery.layer(options), state);
  const buffers = Layer.provideMerge(EditorBuffers.layer, discovery);
  const sync = Layer.provideMerge(RecoverySync.layer, buffers);
  const tabs = Layer.provideMerge(EditorTree.layer, Layer.provideMerge(EditorTabs.layer, sync));
  const saves = Layer.provideMerge(
    EditorSaves.layer,
    Layer.provideMerge(EditorMutations.layer, tabs),
  );
  const actions = Layer.provideMerge(
    Layer.mergeAll(
      UnsavedChangesGuard.layer,
      EditorCheckouts.layer,
      EditorLookup.layer,
      EditorTextSearch.layer,
    ),
    saves,
  );
  return Layer.provideMerge(Layer.mergeAll(EditorLoader.layer, EditorWorktrees.layer), actions);
};
