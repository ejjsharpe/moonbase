import { ApplicationError } from '@moonbase/contracts/workspace';
import * as Schema from 'effect/Schema';
import {
  ChatIdentifierSchema,
  ChatHostTargetSchema,
  ChatSessionSchema,
  decodeChatInput,
} from '@moonbase/contracts/chat-schema';
export {
  checkChatOutput as output,
  checkChatReplySize as sized,
  decodeChatTarget as target,
  isCancellableChatRead as isCancellableRead,
  isChatMutation as isMutation,
  isSameChatHost as sameHost,
  isSameChatTarget as sameTarget,
} from '@moonbase/contracts/chat-validation';

export const fail = (code: ApplicationError['code'], message: string): never => {
  throw new ApplicationError({ code, message });
};
export function object(value: unknown, keys?: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail('InvalidInput', 'Expected a chat object.');
  const record = value as Record<string, unknown>;
  if (keys && Object.keys(record).some((key) => !keys.includes(key)))
    fail('InvalidInput', 'Unexpected chat fields.');
  return record;
}
export function string(value: unknown, bytes: number, empty = false): string {
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    value.includes('\0') ||
    (!empty && !value.trim()) ||
    Buffer.byteLength(value) > bytes
  )
    return fail('InvalidInput', 'Chat text is empty, invalid Unicode, or exceeds its limit.');
  return value;
}
const checked =
  <A>(decode: (value: unknown) => A) =>
  (value: unknown): A => {
    try {
      return decode(value);
    } catch {
      return fail('InvalidInput', 'Invalid chat identity or shape.');
    }
  };
export const id = checked(Schema.decodeUnknownSync(ChatIdentifierSchema));
export const host = checked(
  Schema.decodeUnknownSync(ChatHostTargetSchema, { onExcessProperty: 'error' }),
);
export const session = checked(
  Schema.decodeUnknownSync(ChatSessionSchema, { onExcessProperty: 'error' }),
);
export function cursor(value: unknown): string {
  return string(value, 1024);
}
export const input = decodeChatInput;
export function preview(text: string, bytes = 4096) {
  let result = '',
    used = 0;
  for (const char of text.toWellFormed()) {
    const size = Buffer.byteLength(char);
    if (used + size > bytes) break;
    result += char;
    used += size;
  }
  return { text: result, truncated: result.length < text.length };
}
