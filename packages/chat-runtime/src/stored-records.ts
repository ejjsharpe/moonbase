import * as Schema from 'effect/Schema';
import {
  ChatIdentifierSchema,
  ChatSessionSchema,
  ChatTargetSchema,
  ChatStopTargetSchema,
  chatInputSchemas,
  ChatReasoningEffortSchema,
} from '@moonbase/contracts/chat-schema';
import { fail } from '@moonbase/contracts/errors';
import { absolutePath, boundedText, naturalNumber, recordId } from './field-schemas.ts';

// Moonbase's records in the Pi store, decoded each time they are read.
const storedTarget = Schema.Struct({ ...ChatTargetSchema.fields, conversationId: recordId });
const storedStop = Schema.Struct({
  ...ChatStopTargetSchema.fields,
  target: storedTarget,
  submissionId: recordId,
  taskId: Schema.NullOr(recordId),
});
const binding = Schema.Union([
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
const identity = Schema.Struct({ ...ChatSessionSchema.fields, mode: Schema.Literal('local') });
const store = Schema.Struct({ identity: Schema.String });
const timestamp = boundedText(64).check(
  Schema.makeFilter((value) => Number.isFinite(Date.parse(value))),
);
const metadata = Schema.Struct({
  identity: Schema.String,
  title: boundedText(200),
  createdAt: timestamp,
  settledAt: Schema.optional(timestamp),
  settings: Schema.optional(
    Schema.Struct({
      cwd: absolutePath,
      ownFolder: Schema.optional(Schema.Literal(true)),
      model: Schema.Struct({ provider: ChatIdentifierSchema, modelId: boundedText(256) }),
      reasoningEffort: Schema.optional(ChatReasoningEffortSchema),
    }),
  ),
  pending: naturalNumber,
});

function decode<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
  message = 'Stored Moonbase chat data is invalid; preserve this store without rewriting it.',
): S['Type'] {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: 'error', reportInput: false })(
      value,
    );
  } catch {
    return fail('Persistence', message);
  }
}
const decodeJson = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: string,
  message: string,
): S['Type'] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return fail('Persistence', message);
  }
  return decode(schema, parsed, message);
};
function checkStoredIdentity(value: string) {
  decodeJson(identity, value, 'Stored Moonbase chat authority is invalid.');
}

/** A stored request's binding: the operation and the full input its request ID is bound to. */
export const decodeStoredBinding = (value: string) =>
  decodeJson(binding, value, 'Stored Moonbase request binding is invalid.');
/** A stored request, checked against its binding and the actor and request ID it is read for. */
export function decodeStoredRequest(value: unknown, actorId: string, requestId: string) {
  const result = decode(request, value),
    bound = decodeStoredBinding(result.binding);
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
/** The store's owner record: the identity it is bound to. */
export function decodeStoreOwner(value: unknown) {
  const result = decode(store, value);
  checkStoredIdentity(result.identity);
  return result;
}
/** A chat's metadata: its owner, title, times, settings and pending submissions. */
export function decodeStoredMetadata(value: unknown) {
  const result = decode(metadata, value);
  checkStoredIdentity(result.identity);
  return result;
}
