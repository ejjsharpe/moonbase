/** Browser-safe types of the client recovery store's buffer-keyed format and its edits. */
import type * as Contracts from './recovery-schema.ts';

export type RecoveryBuffer = typeof Contracts.RecoveryBufferSchema.Type;
export type BufferDraft = typeof Contracts.BufferDraftSchema.Type;
export type BufferView = typeof Contracts.BufferViewSchema.Type;
export type RememberedFile = typeof Contracts.RememberedFileSchema.Type;
export type RecoveryLayout = typeof Contracts.RecoveryLayoutSchema.Type;
export type RecoveryState = typeof Contracts.RecoveryStateSchema.Type;
export type RecoveryOutline = typeof Contracts.RecoveryOutlineSchema.Type;
export type RecoveryEdits = {
  [K in keyof typeof Contracts.recoveryEditInputSchemas]: {
    input: (typeof Contracts.recoveryEditInputSchemas)[K]['Type'];
    output: (typeof Contracts.recoveryEditOutputSchemas)[K]['Type'];
  };
};
export type RecoveryEdit = keyof RecoveryEdits;
export type RecoveryEditInput<K extends RecoveryEdit> = RecoveryEdits[K]['input'];

export const emptyBufferView = (): BufferView => ({
  tabs: [],
  active: null,
  preview: null,
  fileViews: {},
  positions: {},
  remembered: {},
  tree: { expanded: [], selected: [], focus: '', scroll: 0 },
});
export const emptyRecoveryState = (clientId: string): RecoveryState => ({
  version: 2,
  clientId,
  checkouts: [],
  openCheckoutIds: [],
  selectedCheckoutId: null,
  views: {},
  buffers: [],
  recentFiles: [],
  sidebarWidth: 270,
  followActiveFile: true,
});
