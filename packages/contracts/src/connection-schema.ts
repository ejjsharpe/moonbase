import * as Schema from 'effect/Schema';
import { ApplicationError } from './errors.ts';
import type { ConnectionCommand, ConnectionInput, ConnectionOutput } from './connection.ts';
import { ChatHostHealthSchema, ChatHostTargetSchema, ChatIdentifierSchema } from './host-schema.ts';
import { optional, struct, voidResult } from './schema.ts';

export const ConnectionPortSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 65535 }),
);
export const ConnectionProfileSchema = struct({
  id: ChatIdentifierSchema,
  // oxlint-disable-next-line no-control-regex -- Public SSH labels reject control characters.
  label: Schema.String.check(Schema.isPattern(/^[^\x00-\x1f\x7f]{1,128}$/)),
  destination: Schema.String.check(
    Schema.isMaxLength(320),
    Schema.isPattern(
      /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}@)?(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,252}|\[[0-9A-Fa-f:.%_-]+\])$/,
    ),
  ),
  /** The host's port: required over SSH; a loopback connection knows it once it has read one. */
  remotePort: optional(ConnectionPortSchema),
  expected: ChatHostTargetSchema,
});
const common = { profile: ConnectionProfileSchema, message: optional(Schema.String) };
export const ConnectionSnapshotSchema = Schema.Union([
  struct({ ...common, state: Schema.Literal('disconnected'), connectionId: Schema.Null }),
  struct({ ...common, state: Schema.Literal('connecting'), connectionId: ChatIdentifierSchema }),
  struct({ ...common, state: Schema.Literal('disconnecting'), connectionId: ChatIdentifierSchema }),
  struct({
    ...common,
    state: Schema.Literal('connected'),
    connectionId: ChatIdentifierSchema,
    health: ChatHostHealthSchema,
  }),
  struct({
    ...common,
    state: Schema.Literal('failed'),
    connectionId: Schema.NullOr(ChatIdentifierSchema),
  }),
]);
export const connectionInputSchemas = {
  getConnection: Schema.Record(Schema.String, Schema.mutableKey(Schema.Never)),
  connect: struct({ profileId: ChatIdentifierSchema }),
  disconnect: struct({ connectionId: ChatIdentifierSchema }),
};
export const connectionOutputSchemas = {
  getConnection: ConnectionSnapshotSchema,
  connect: ConnectionSnapshotSchema,
  disconnect: voidResult,
} satisfies Record<keyof typeof connectionInputSchemas, Schema.Constraint>;
const inputs = Object.fromEntries(
  Object.entries(connectionInputSchemas).map(([name, schema]) => [
    name,
    Schema.decodeUnknownSync(schema, { onExcessProperty: 'error', reportInput: false }),
  ]),
);
const outputs = Object.fromEntries(
  Object.entries(connectionOutputSchemas).map(([name, schema]) => [
    name,
    Schema.decodeUnknownSync(schema, { reportInput: false }),
  ]),
);
export const isConnectionCommand = (value: unknown): value is ConnectionCommand =>
  typeof value === 'string' && Object.hasOwn(connectionInputSchemas, value);
export function decodeConnectionInput<K extends ConnectionCommand>(
  operation: K,
  value: unknown,
): ConnectionInput<K> {
  try {
    if (!isConnectionCommand(operation)) throw Error();
    return inputs[operation](value) as ConnectionInput<K>;
  } catch {
    throw new ApplicationError({ code: 'InvalidInput', message: 'Invalid connection input.' });
  }
}
export function decodeConnectionOutput<K extends ConnectionCommand>(
  operation: K,
  value: unknown,
): ConnectionOutput<K> {
  try {
    if (!isConnectionCommand(operation)) throw Error();
    return outputs[operation](value) as ConnectionOutput<K>;
  } catch {
    throw new ApplicationError({ code: 'Incompatible', message: 'Invalid connection reply.' });
  }
}
const profile = Schema.decodeUnknownSync(ConnectionProfileSchema, { reportInput: false });
const snapshot = Schema.decodeUnknownSync(ConnectionSnapshotSchema, { reportInput: false });
export function decodeConnectionProfile(value: unknown): typeof ConnectionProfileSchema.Type {
  try {
    return profile(value);
  } catch {
    throw new ApplicationError({ code: 'InvalidInput', message: 'Invalid connection profile.' });
  }
}
export function decodeConnectionSnapshot(value: unknown): typeof ConnectionSnapshotSchema.Type {
  try {
    return snapshot(value);
  } catch {
    throw new ApplicationError({ code: 'Incompatible', message: 'Invalid connection snapshot.' });
  }
}
