import { ApplicationError } from '@moonbase/contracts/workspace';
import { decodeChatInput, isChatCommand } from '@moonbase/contracts/chat-schema';
import type { ChatCommand } from '@moonbase/contracts/chat';
export {
  checkChatOutput as output,
  decodeChatTarget as target,
  isCancellableChatRead as isCancellableRead,
  isChatMutation as isMutation,
  isSameChatHost as sameHost,
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
export function command(value: unknown): ChatCommand {
  if (!isChatCommand(value)) return fail('InvalidInput', 'Unknown chat operation.');
  return value;
}
export const input = decodeChatInput;
