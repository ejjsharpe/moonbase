/** The file host's operations: workspace commands without recovery, plus the journal queries. */
import type { CommandOptions } from './common.ts';
import type * as Contracts from './workspace-host-schema.ts';
import type { CheckoutTarget } from './workspace.ts';

export type HostCommands = {
  [K in keyof typeof Contracts.hostInputSchemas]: {
    input: (typeof Contracts.hostInputSchemas)[K]['Type'];
    output: (typeof Contracts.hostOutputSchemas)[K]['Type'];
  };
};
export type HostCommand = keyof HostCommands;
export type HostInput<K extends HostCommand> = HostCommands[K]['input'];
export type HostOutput<K extends HostCommand> = HostCommands[K]['output'];
export type HostOperationResult = typeof Contracts.HostOperationResultSchema.Type;
export type HostSaveResult = typeof Contracts.HostSaveResultSchema.Type;
export type SaveStatus = typeof Contracts.SaveStatusSchema.Type;
export type OperationFeedEntry = typeof Contracts.OperationFeedEntrySchema.Type;
export type OperationFeed = typeof Contracts.OperationFeedSchema.Type;
/** What a `workspace` subscription's target names. */
export type WorkspaceWatchTarget = typeof Contracts.WorkspaceWatchTargetSchema.Type;
/** What a `workspace` subscription describes: see `WorkspaceWatchValueSchema`. */
export type WorkspaceWatchValue = typeof Contracts.WorkspaceWatchValueSchema.Type;
/**
 * The file host as the socket server calls it: promise-shaped, with the watch already combined
 * with the operation feed. A daemon builds it from its file host and injects it into the server,
 * which then advertises `workspace-v1`.
 */
export type WorkspaceHostClient = {
  /** Runs one host operation; `signal` cancels a read, and is not passed to a mutation. */
  command<K extends HostCommand>(
    operation: K,
    input: HostInput<K>,
    options?: CommandOptions,
  ): Promise<HostOutput<K>>;
  /** Follows a checkout; `receive` gets a fresh value after each change. Returns its stop. */
  watch(
    input: { checkout: CheckoutTarget },
    receive: (value: WorkspaceWatchValue) => void,
    onError: (error: unknown) => void,
  ): () => Promise<void>;
};
