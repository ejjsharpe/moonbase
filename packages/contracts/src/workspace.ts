/** Browser-safe application boundary. Privileged implementations use ./services. */
export const maximumFileBytes = 2 * 1024 * 1024;
import type * as Contracts from './workspace-schema.ts';
import type { ApplicationError } from './errors.ts';
import type { CommandOptions, ObservationClose } from './common.ts';
export { ApplicationError, type ApplicationErrorCode } from './errors.ts';
export type { CommandOptions, ObservationClose } from './common.ts';
export type CheckoutTarget = typeof Contracts.CheckoutTargetSchema.Type;
export type FileTarget = typeof Contracts.FileTargetSchema.Type;
export type FileDocument = typeof Contracts.FileDocumentSchema.Type;
export type FileView = typeof Contracts.FileViewSchema.Type;
export type EditorPosition = typeof Contracts.EditorPositionSchema.Type;
export type CheckoutView = typeof Contracts.CheckoutViewSchema.Type;
export type RecoveryDraft = typeof Contracts.RecoveryDraftSchema.Type;
export type EditorRecovery = typeof Contracts.EditorRecoverySchema.Type;
export type RecoveryLoad = typeof Contracts.RecoveryLoadSchema.Type;
export type DirectoryEntry = typeof Contracts.DirectoryEntrySchema.Type;
export type DirectoryListing = typeof Contracts.DirectoryListingSchema.Type;
export type GitChange = typeof Contracts.GitChangeSchema.Type;
export type GitChangeKind = typeof Contracts.GitChangeKindSchema.Type;
export type GitStatus = typeof Contracts.GitStatusSchema.Type;
export type Worktree = typeof Contracts.WorktreeSchema.Type;
export type Comparison = typeof Contracts.ComparisonSchema.Type;
export type LookupMatch = typeof Contracts.LookupMatchSchema.Type;
export type TextMatch = typeof Contracts.TextMatchSchema.Type;
export type TextSearchFile = typeof Contracts.TextSearchFileSchema.Type;
export type RecoveryChange = typeof Contracts.RecoveryChangeSchema.Type;
export type RecoveryPublication = typeof Contracts.RecoveryPublicationSchema.Type;
export type EntryReference = typeof Contracts.EntryReferenceSchema.Type;
export type WorkspaceOperation = typeof Contracts.WorkspaceOperationSchema.Type;
export type OperationResult = typeof Contracts.OperationResultSchema.Type;
export type SaveResult = typeof Contracts.SaveResultSchema.Type;
export type WorkspaceEvent = typeof Contracts.WorkspaceEventSchema.Type;
export const emptyRecovery = (clientId: string): EditorRecovery => ({
  version: 1,
  clientId,
  checkouts: [],
  openCheckoutIds: [],
  selectedCheckoutId: null,
  views: {},
  drafts: [],
  recentFiles: [],
  sidebarWidth: 270,
});
export type WorkspaceCommands = {
  [K in keyof typeof Contracts.workspaceInputSchemas]: {
    input: (typeof Contracts.workspaceInputSchemas)[K]['Type'];
    output: (typeof Contracts.workspaceOutputSchemas)[K]['Type'];
  };
};
export type WorkspaceCommand = keyof WorkspaceCommands;
export type CommandInput<K extends WorkspaceCommand> = WorkspaceCommands[K]['input'];
export type CommandOutput<K extends WorkspaceCommand> = WorkspaceCommands[K]['output'];
export interface EditorClient {
  command<K extends WorkspaceCommand>(
    operation: K,
    input: CommandInput<K>,
    options?: CommandOptions,
  ): Promise<CommandOutput<K>>;
  watch(
    input: { checkout: CheckoutTarget; paths: string[] },
    receive: (event: WorkspaceEvent) => void,
    onError: (error: ApplicationError) => void,
  ): ObservationClose;
}
