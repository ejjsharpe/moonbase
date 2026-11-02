/** Browser-safe application boundary. Privileged implementations use ./services. */
export const maximumFileBytes = 2 * 1024 * 1024;
import type * as Contracts from './workspace-schema.ts';
import type { ApplicationErrorCodeSchema } from './error-schema.ts';
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
export type GitStatus = typeof Contracts.GitStatusSchema.Type;
export type Comparison = typeof Contracts.ComparisonSchema.Type;
export type LookupMatch = typeof Contracts.LookupMatchSchema.Type;
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
export type ApplicationErrorCode = typeof ApplicationErrorCodeSchema.Type;
export class ApplicationError extends Error {
  // oxlint-disable-next-line no-unused-private-class-members -- Private-brand membership below authenticates errors without trusting public fields.
  #applicationError = true;
  readonly _tag = 'ApplicationError';
  readonly code: ApplicationErrorCode;
  readonly target?: FileTarget;
  constructor(options: { code: ApplicationErrorCode; message: string; target?: FileTarget }) {
    super(options.message);
    this.name = 'ApplicationError';
    this.code = options.code;
    this.target = options.target;
  }
  static is(value: unknown): value is ApplicationError {
    try {
      return typeof value === 'object' && value !== null && #applicationError in value;
    } catch {
      return false;
    }
  }
  static fromUnknown(value: unknown): ApplicationError {
    if (ApplicationError.is(value)) return value;
    let message: string;
    try {
      message = String(value);
    } catch {
      message = 'Unprintable application failure';
    }
    return new ApplicationError({ code: 'Unavailable', message });
  }
}
export type ObservationClose = () => Promise<void>;
export type CommandOptions = { signal?: AbortSignal };
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
