import * as Schema from 'effect/Schema';
import { ApplicationError } from './client.ts';
import { chatHostVersion, chatProtocolVersion } from './host-client.ts';
import { array, struct } from './schema.ts';

export const ChatIdentifierSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9._:-]{1,256}$/),
);
export const ChatHostTargetSchema = struct({
  hostId: ChatIdentifierSchema,
  storeId: ChatIdentifierSchema,
});
export const ChatHostHealthSchema = struct({
  ...ChatHostTargetSchema.fields,
  protocol: Schema.Literal(chatProtocolVersion),
  version: Schema.Literal(chatHostVersion),
  capabilities: array(Schema.String.check(Schema.isMaxLength(64))).check(
    Schema.isMaxLength(16),
    Schema.makeFilter((value) => value.includes('chat-v0')),
  ),
});
const target = Schema.decodeUnknownSync(ChatHostTargetSchema, {
  onExcessProperty: 'error',
  reportInput: false,
});
const health = Schema.decodeUnknownSync(ChatHostHealthSchema, { reportInput: false });
export function decodeChatHostTarget(value: unknown): typeof ChatHostTargetSchema.Type {
  try {
    return target(value);
  } catch {
    throw new ApplicationError({ code: 'InvalidInput', message: 'Invalid chat host target.' });
  }
}
export function decodeChatHostHealth(value: unknown): typeof ChatHostHealthSchema.Type {
  try {
    return health(value);
  } catch {
    throw new ApplicationError({
      code: 'Incompatible',
      message: 'Chat host protocol, version or capabilities are incompatible.',
    });
  }
}
