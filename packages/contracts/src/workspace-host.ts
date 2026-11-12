/** The file host's operations: workspace commands without recovery, plus the journal queries. */
import type * as Contracts from './workspace-host-schema.ts';

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
