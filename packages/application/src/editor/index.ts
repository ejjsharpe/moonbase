export { editorLayer, type EditorOptions, type EditorServices } from './editor-layer.ts';
export { makeEditorAtoms, type EditorAtoms } from './editor-atoms.ts';
export { toEditorSnapshot, type EditorSnapshot, type EditorParts } from './editor-snapshot.ts';
export {
  EditorError,
  isEditorError,
  getFailureCode,
  type EditorErrorReason,
  type EditorFailure,
} from './editor-errors.ts';
export { describeEditorFailure } from './alerts/alerts.ts';
export { readOwn } from './record.ts';
export { checkoutKey, fileKey, sameCheckout } from './recovery/recovery-references.ts';
export type { CheckoutView, EditorRecovery, EditorTab } from './recovery/recovery-layout.ts';

export { EditorSession, type SessionState } from './session/session-service.ts';
export { EditorAlerts } from './alerts/alerts-service.ts';
export { EditorViews } from './views/views-service.ts';
export { EditorOperations } from './operations/operations-service.ts';
export { RecoveryOutbox } from './recovery/recovery-outbox-service.ts';
export { RecoverySync } from './recovery/recovery-sync-service.ts';
export { EditorDiscovery } from './discovery/discovery-service.ts';
export { EditorBuffers } from './buffers/buffers-service.ts';
export type { EditorBuffer } from './buffers/buffers.ts';
export { EditorTabs } from './tabs/tabs-service.ts';
export type { OpenOptions } from './tabs/tabs.ts';
export { EditorTree } from './tree/tree-service.ts';
export type { RevealOptions } from './tree/tree.ts';
export { EditorMutations, type OperationInput } from './mutation/mutation-service.ts';
export {
  admitsMutation,
  maxMutationEntries,
  mutationUnavailable,
  getMutationDestinations,
  type MutationAction,
  type MutationOptions,
  type MutationRunResult,
  type MutationState,
  type ReplacePrompt,
} from './mutation/mutation.ts';
export { EditorSaves } from './saves/saves-service.ts';
export { EditorPreservation } from './preservation/preservation-service.ts';
export type { CloseChoice, ClosePrompt } from './preservation/preservation.ts';
export { EditorCheckouts } from './checkouts/checkouts-service.ts';
export { EditorLookup, type Lookup } from './lookup/lookup-service.ts';
export type { LookupRow, LookupSnapshot } from './lookup/lookup.ts';
export { EditorTextSearch, type TextSearch } from './text-search/text-search-service.ts';
export type { TextSearchOptions, TextSearchSnapshot } from './text-search/text-search.ts';
export { EditorLoader } from './editor-loader.ts';
