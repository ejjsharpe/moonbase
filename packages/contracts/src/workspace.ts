/** Browser-safe application boundary. Privileged implementations use ./services. */
export const maximumFileBytes = 2 * 1024 * 1024;
import type * as Contracts from './workspace-schema.ts';
import type { RecoveryCommands } from './recovery.ts';
export type { RecoveryLoad } from './recovery.ts';
export type CheckoutTarget = typeof Contracts.CheckoutTargetSchema.Type;
export type GitCheckoutTarget = typeof Contracts.GitCheckoutTargetSchema.Type;
export type FileTarget = typeof Contracts.FileTargetSchema.Type;
export type FileDocument = typeof Contracts.FileDocumentSchema.Type;
export type FileView = typeof Contracts.FileViewSchema.Type;
export type EditorPosition = typeof Contracts.EditorPositionSchema.Type;
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
export type EntryReference = typeof Contracts.EntryReferenceSchema.Type;
export type WorkspaceOperation = typeof Contracts.WorkspaceOperationSchema.Type;
export type OperationResult = typeof Contracts.OperationResultSchema.Type;
export type SaveResult = typeof Contracts.SaveResultSchema.Type;
export type WorkspaceEvent = typeof Contracts.WorkspaceEventSchema.Type;
export type FilePositions = typeof Contracts.FilePositionsSchema.Type;
export type CheckoutTree = typeof Contracts.CheckoutTreeSchema.Type;
/** The workspace's file commands, with the recovery store's commands (`./recovery`). */
export type WorkspaceCommands = {
  [K in keyof typeof Contracts.workspaceInputSchemas]: {
    input: (typeof Contracts.workspaceInputSchemas)[K]['Type'];
    output: (typeof Contracts.workspaceOutputSchemas)[K]['Type'];
  };
} & RecoveryCommands;
export type WorkspaceCommand = keyof WorkspaceCommands;
export type CommandInput<K extends WorkspaceCommand> = WorkspaceCommands[K]['input'];
export type CommandOutput<K extends WorkspaceCommand> = WorkspaceCommands[K]['output'];
