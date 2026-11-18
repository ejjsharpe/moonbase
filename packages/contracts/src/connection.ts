import type * as Contracts from './connection-schema.ts';
export type ConnectionProfile = typeof Contracts.ConnectionProfileSchema.Type;
export type ConnectionSnapshot = typeof Contracts.ConnectionSnapshotSchema.Type;
export type ConnectionCommands = {
  [K in keyof typeof Contracts.connectionInputSchemas]: {
    input: (typeof Contracts.connectionInputSchemas)[K]['Type'];
    output: (typeof Contracts.connectionOutputSchemas)[K]['Type'];
  };
};
export type ConnectionCommand = keyof ConnectionCommands;
export type ConnectionInput<K extends ConnectionCommand> = ConnectionCommands[K]['input'];
export type ConnectionOutput<K extends ConnectionCommand> = ConnectionCommands[K]['output'];
