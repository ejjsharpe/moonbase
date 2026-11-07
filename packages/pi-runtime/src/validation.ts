import { ApplicationError } from '@moonbase/contracts/workspace';
import { areJsonValuesEqual } from '@moonbase/contracts/common';
import * as Schema from 'effect/Schema';
import {
  ChatIdentifierSchema,
  ChatHostTargetSchema,
  ChatSessionSchema,
  ChatTargetSchema,
  decodeChatInput,
  decodeChatOutput,
  isChatCommand,
} from '@moonbase/contracts/chat-schema';
import {
  maximumChatReplyBytes,
  type ChatTranscript,
  type ChatCommand,
  type ChatInput,
  type ChatOutput,
  type ChatSession,
  type ChatTarget,
  type ChatSummary,
  type ChatSnapshot,
} from '@moonbase/contracts/chat';
import type { ChatHostTarget } from '@moonbase/contracts/host';

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
export const target = checked(
  Schema.decodeUnknownSync(ChatTargetSchema, { onExcessProperty: 'error' }),
);
export const sameHost = (a: ChatHostTarget, b: ChatHostTarget) =>
  a.hostId === b.hostId && a.storeId === b.storeId;
export const sameTarget = (a: ChatTarget, b: ChatTarget) =>
  sameHost(a.host, b.host) && a.actorId === b.actorId && a.conversationId === b.conversationId;
export function cursor(value: unknown): string {
  return string(value, 1024);
}
/** Reads a caller may abandon; every other command runs to completion once dispatched. */
export const isCancellableRead = (operation: ChatCommand) =>
  operation === 'getChatTranscriptContent' ||
  operation === 'getChatHistoryAround' ||
  operation === 'findChatTranscript' ||
  operation === 'findChatFiles';
export function command(value: unknown): ChatCommand {
  if (!isChatCommand(value)) return fail('InvalidInput', 'Unknown chat operation.');
  return value;
}
export const input = decodeChatInput;
export function sized<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > maximumChatReplyBytes - 256)
    fail('InvalidInput', 'Chat reply exceeds its delivery limit.');
  return value;
}
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
/** Project network results explicitly; schemas grant no remote authority. */
export function output<K extends ChatCommand>(
  operation: K,
  value: unknown,
  request: ChatInput<K>,
): ChatOutput<K> {
  const result = decodeChatOutput(operation, value);
  if (operation === 'getChat') {
    const snapshot = result as ChatSnapshot;
    if (snapshot.run && !sameTarget(snapshot.run.stop.target, snapshot.conversation.target))
      fail('Incompatible', 'Run target differs from its conversation.');
  }
  const r = result as Record<string, unknown> | null,
    q = request as Record<string, unknown>;
  const requestedSession = q.session as ChatSession | undefined;
  if (operation === 'findChatFiles') {
    if (r!.query !== q.query) fail('Incompatible', 'File search identity changed.');
  } else if (requestedSession) {
    const summaries =
      operation === 'listChats'
        ? (r!.conversations as ChatSummary[])
        : [r!.conversation as ChatSummary];
    if (
      summaries.some(
        (s) =>
          !sameHost(s.target.host, requestedSession.host) ||
          s.target.actorId !== requestedSession.actorId,
      )
    )
      fail('Incompatible', 'Chat authority changed.');
  }
  if (operation === 'getChatHost' && !sameHost(r!.host as ChatHostTarget, q.host as ChatHostTarget))
    fail('Incompatible', 'Chat host changed.');
  const validateTranscript = (transcript: ChatTranscript, target: ChatTarget, id?: string) => {
    if (
      !sameTarget(transcript.source.target, target) ||
      (id !== undefined && (transcript.source.kind !== 'entry' || transcript.source.entryId !== id))
    )
      fail('Incompatible', 'Transcript source changed.');
    if (new Set(transcript.parts.map((part) => part.partId)).size !== transcript.parts.length)
      fail('Incompatible', 'Transcript contains duplicate part identities.');
  };
  if (
    operation === 'getChat' ||
    operation === 'getChatHistoryAround' ||
    operation === 'getChatHistory'
  ) {
    const target = q.target as ChatTarget;
    for (const entry of r!.entries as ChatSnapshot['entries'])
      if (entry.transcript) validateTranscript(entry.transcript, target, entry.id);
    if (operation === 'getChat') {
      const run = (result as ChatSnapshot).run;
      if (run?.transcript) {
        validateTranscript(run.transcript, target);
        const source = run.transcript.source;
        if (
          source.kind !== 'live' ||
          source.submissionId !== run.stop.submissionId ||
          source.taskId !== run.stop.taskId
        )
          fail('Incompatible', 'Live transcript authority changed.');
      }
    }
  }
  if (operation === 'findChatTranscript') {
    const data = result as ChatOutput<'findChatTranscript'>,
      input = request as ChatInput<'findChatTranscript'>;
    if (
      data.query !== input.query ||
      data.cursor !== (input.cursor ?? null) ||
      data.matches.some((match) => !sameTarget(match.source.target, input.target))
    )
      fail('Incompatible', 'Find read identity changed.');
  }
  if (operation === 'getChatHistoryAround') {
    if (r!.entryId !== q.entryId || r!.cursor !== (q.cursor ?? null))
      fail('Incompatible', 'History read identity changed.');
  }
  if (operation === 'getChatTranscriptContent') {
    const data = result as ChatOutput<'getChatTranscriptContent'>;
    const input = request as ChatInput<'getChatTranscriptContent'>;
    if (!areJsonValuesEqual(data.source, input.source) || data.cursor !== (input.cursor ?? null))
      fail('Incompatible', 'Content read identity changed.');
    if (data.kind === 'manifest') {
      if (input.selection) fail('Incompatible', 'Content selection was ignored.');
      validateTranscript(data, input.source.target);
    } else {
      if (!input.selection || !areJsonValuesEqual(data.selection, input.selection))
        fail('Incompatible', 'Content selection changed.');
    }
  }
  if (q.target && r) {
    const actual =
      operation === 'getChat'
        ? (r.conversation as ChatSummary).target
        : (r.target as ChatTarget | undefined);
    if (actual && !sameTarget(actual, q.target as ChatTarget))
      fail('Incompatible', 'Chat target changed.');
  }
  if (q.requestId && r?.requestId !== undefined && q.requestId !== r.requestId)
    fail('Incompatible', 'Chat request identity changed.');
  if (operation === 'stopChat' && !areJsonValuesEqual(r!.stop, q.stop))
    fail('Incompatible', 'Stop authority changed.');
  return sized(result);
}
