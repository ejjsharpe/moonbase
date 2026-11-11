import { isAbsolute } from 'node:path';
import * as Schema from 'effect/Schema';
import type { ChatCreationSettings } from '@moonbase/contracts/chat';
import type { Models } from '@earendil-works/pi-ai/models';
import type { Registry } from '@earendil-works/pi-durable';
import {
  ChatIdentifierSchema,
  ChatHostTargetSchema,
  ChatSessionSchema,
  ChatTargetSchema,
  ChatStopTargetSchema,
  chatInputSchemas,
  ChatReasoningEffortSchema,
} from '@moonbase/contracts/chat-schema';
import { fail } from './validation.ts';

const text = (bytes: number) =>
  Schema.String.check(
    Schema.makeFilter(
      (value) =>
        value.isWellFormed() &&
        !value.includes('\0') &&
        !!value.trim() &&
        Buffer.byteLength(value) <= bytes,
    ),
  );
const path = text(4096).check(Schema.makeFilter(isAbsolute));
const integer = Schema.Number.check(Schema.makeFilter(Number.isSafeInteger));
const recordId = Schema.String.check(
  Schema.makeFilter((value) => /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value))),
);
const model = Schema.Struct({ provider: ChatIdentifierSchema, modelId: text(256) });
const identity = Schema.Struct({ ...ChatSessionSchema.fields, cwd: path, model });
const configuration = {
  ...identity.fields,
  databasePath: path,
};
const token = Schema.String.check(
  Schema.makeFilter((value) => /^[\x21-\x7e]{16,4096}$/.test(value)),
);
const port = integer.check(Schema.makeFilter((value) => value >= 0 && value <= 65535));
const cli = Schema.Struct({
  ...configuration,
  token,
  port: port.check(Schema.makeFilter((value) => value > 0)),
});
const programmatic = Schema.Struct({
  ...configuration,
  // Supplied public SDK capabilities retain their identity; their internals are not configuration.
  models: Schema.declare<Models>(
    (value): value is Models => !!value && typeof (value as Models).getModel === 'function',
  ),
  registry: Schema.optional(Schema.declare<Registry>((value): value is Registry => !!value)),
  ripgrepExecutable: Schema.optional(path),
});
const server = Schema.Struct({ host: ChatHostTargetSchema, token, port });
const daemon = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal('local'),
    credentialKey: Schema.optional(
      Schema.Union([
        Schema.Struct({ source: Schema.Literal('keychain') }),
        Schema.Struct({ source: Schema.Literal('file'), path }),
      ]),
    ),
  }),
  Schema.Struct({
    mode: Schema.Literal('host'),
    cwd: path,
    model,
    port: port.check(Schema.makeFilter((value) => value > 0)),
  }),
]);
const storedTarget = Schema.Struct({ ...ChatTargetSchema.fields, conversationId: recordId });
const storedStop = Schema.Struct({
  ...ChatStopTargetSchema.fields,
  target: storedTarget,
  submissionId: recordId,
  taskId: Schema.NullOr(recordId),
});
const bindings = Schema.Union([
  Schema.Struct({ operation: Schema.Literal('createChat'), ...chatInputSchemas.createChat.fields }),
  Schema.Struct({
    operation: Schema.Literal('sendChat'),
    ...chatInputSchemas.sendChat.fields,
    target: storedTarget,
  }),
  Schema.Struct({
    operation: Schema.Literal('stopChat'),
    ...chatInputSchemas.stopChat.fields,
    stop: storedStop,
  }),
]);
const request = Schema.Struct({
  binding: Schema.String,
  conversationId: Schema.NullOr(recordId),
  submissionId: Schema.NullOr(recordId),
  pending: Schema.Boolean,
});
const localIdentity = Schema.Struct({ ...ChatSessionSchema.fields, mode: Schema.Literal('local') });
const localProgrammatic = Schema.Struct({
  ...localIdentity.fields,
  databasePath: path,
  models: programmatic.fields.models,
  registry: programmatic.fields.registry,
  approveCreation: Schema.optional(
    Schema.declare<(settings: ChatCreationSettings) => Promise<void>>(
      (value): value is (settings: ChatCreationSettings) => Promise<void> =>
        typeof value === 'function',
    ),
  ),
  approveFolder: Schema.optional(
    Schema.declare<(cwd: string) => Promise<void>>(
      (value): value is (cwd: string) => Promise<void> => typeof value === 'function',
    ),
  ),
  chatFolders: Schema.optional(path),
  ripgrepExecutable: Schema.optional(path),
});
const store = Schema.Struct({ identity: Schema.String });
const timestamp = text(64).check(Schema.makeFilter((value) => Number.isFinite(Date.parse(value))));
const metadata = Schema.Struct({
  identity: Schema.String,
  title: text(200),
  createdAt: timestamp,
  settledAt: Schema.optional(timestamp),
  settings: Schema.optional(
    Schema.Struct({
      cwd: path,
      ownFolder: Schema.optional(Schema.Literal(true)),
      model,
      reasoningEffort: Schema.optional(ChatReasoningEffortSchema),
    }),
  ),
  pending: integer.check(Schema.makeFilter((value) => value >= 0)),
});
// Pi owns scan positions. Only Moonbase's envelope and start sentinel are interpreted here.
const cursor = Schema.Struct({
  kind: Schema.Literals(['list', 'history']),
  conversationId: Schema.optional(text(512)),
  scan: Schema.NullOr(Schema.Record(Schema.String, Schema.Json)),
});
function decode<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
  saved = false,
): S['Type'] {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: 'error', reportInput: false })(
      value,
    );
  } catch {
    return fail(
      saved ? 'Persistence' : 'InvalidInput',
      saved
        ? 'Stored Moonbase chat data is invalid; preserve this store without rewriting it.'
        : 'Invalid private chat configuration or cursor.',
    );
  }
}
export const cliConfiguration = (value: unknown) => decode(cli, value);
export const runtimeConfiguration = (value: unknown) => decode(programmatic, value);
export const localConfiguration = (value: unknown) => decode(localProgrammatic, value);
export const serverConfiguration = (value: unknown) => decode(server, value);
export const daemonSettings = (value: unknown) => decode(daemon, value);
export type DaemonSettings = typeof daemon.Type;
export function cursorEnvelope(value: unknown) {
  const result = decode(cursor, value);
  if (result.scan?.start === true)
    decode(Schema.Struct({ start: Schema.Literal(true) }), result.scan);
  return result;
}
export function savedBinding(value: string) {
  try {
    return decode(bindings, JSON.parse(value), true);
  } catch {
    return fail('Persistence', 'Stored Moonbase request binding is invalid.');
  }
}
export function savedRequest(value: unknown, actorId: string, requestId: string) {
  const result = decode(request, value, true),
    bound = savedBinding(result.binding);
  let session;
  if (bound.operation === 'createChat') session = bound.session;
  else session = bound.operation === 'sendChat' ? bound.target : bound.stop.target;
  if (bound.operation === 'sendChat' && result.conversationId !== bound.target.conversationId)
    fail('Persistence', 'Stored Moonbase request conversation is invalid.');
  if (
    (bound.operation !== 'sendChat' && (result.pending || result.submissionId !== null)) ||
    (result.pending && result.submissionId !== null)
  )
    fail('Persistence', 'Stored Moonbase request state is invalid.');
  if (session.actorId !== actorId || bound.requestId !== requestId)
    fail('Persistence', 'Stored Moonbase request authority is invalid.');
  return result;
}
export function savedStore(value: unknown) {
  const result = decode(store, value, true);
  savedIdentity(result.identity);
  return result;
}
export function savedMetadata(value: unknown) {
  const result = decode(metadata, value, true);
  savedIdentity(result.identity);
  return result;
}
function savedIdentity(value: string) {
  try {
    decode(Schema.Union([identity, localIdentity]), JSON.parse(value), true);
  } catch {
    fail('Persistence', 'Stored Moonbase chat authority is invalid.');
  }
}

const findPartPositionSchema = Schema.Struct({
  message: integer.check(Schema.makeFilter((value) => value >= 0)),
  block: integer.check(Schema.makeFilter((value) => value >= 0)),
  auxiliary: integer.check(Schema.makeFilter((value) => value >= 0)),
});
export type FindPartPosition = typeof findPartPositionSchema.Type;
/**
 * Find JSON token paths are bounded so a sealed find cursor always fits the 1024-character cursor
 * schema: the other fields need at most 353 JSON bytes, leaving 382 of the 735 a cursor can encode.
 */
export const maximumFindPathDepth = 32;
export const maximumFindPathChars = 360;
const transcriptCursorSchema = Schema.Struct({
  kind: Schema.Literals(['manifest', 'content', 'around', 'find']),
  binding: Schema.String.check(Schema.makeFilter((value) => /^[a-f0-9]{64}$/.test(value))),
  position: integer.check(Schema.makeFilter((value) => value >= 0)),
  revision: Schema.optional(
    Schema.String.check(Schema.makeFilter((value) => /^[a-f0-9]{64}$/.test(value))),
  ),
  upper: Schema.optional(recordId),
  entries: Schema.optional(integer),
  bytes: Schema.optional(integer),
  part: Schema.optional(findPartPositionSchema),
  path: Schema.optional(
    Schema.Array(integer.check(Schema.makeFilter((value) => value >= 0))).check(
      Schema.isMaxLength(maximumFindPathDepth),
      Schema.makeFilter((value) => JSON.stringify(value).length <= maximumFindPathChars),
    ),
  ),
  offset: Schema.optional(integer.check(Schema.makeFilter((value) => value >= 0))),
  textOffset: Schema.optional(integer.check(Schema.makeFilter((value) => value >= 0))),
  direction: Schema.optional(Schema.Literals(['older', 'newer'])),
});
export type TranscriptCursor = typeof transcriptCursorSchema.Type;
export const transcriptCursor = (value: unknown) => decode(transcriptCursorSchema, value);
