import * as Schema from 'effect/Schema';
import { areJsonValuesEqual } from '../shared/common.ts';
import { fail } from '../errors/errors.ts';
import { ChatTargetSchema, decodeChatOutput } from './schema.ts';
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
} from './chat.ts';
import type { ChatHostTarget } from '../host/host.ts';

// Checks shared by the chat engine and the daemon protocol: both project the replies they hand
// on, so a reply's authority is checked the same way on either side of the wire.
const decodeTarget = Schema.decodeUnknownSync(ChatTargetSchema, { onExcessProperty: 'error' });
export const decodeChatTarget = (value: unknown): ChatTarget => {
  try {
    return decodeTarget(value);
  } catch {
    return fail('InvalidInput', 'Invalid chat identity or shape.');
  }
};
export const isSameChatHost = (a: ChatHostTarget, b: ChatHostTarget) =>
  a.hostId === b.hostId && a.storeId === b.storeId;
export const isSameChatTarget = (a: ChatTarget, b: ChatTarget) =>
  isSameChatHost(a.host, b.host) &&
  a.actorId === b.actorId &&
  a.conversationId === b.conversationId;
/** Commands that change chat state: a lost reply is `Uncertain`, and Quit waits for them. */
export const isChatMutation = (operation: ChatCommand) =>
  operation === 'createChat' ||
  operation === 'sendChat' ||
  operation === 'stopChat' ||
  operation === 'settleChat';
/** Reads a caller may abandon; every other command runs to completion once dispatched. */
export const isCancellableChatRead = (operation: ChatCommand) =>
  operation === 'getChatTranscriptContent' ||
  operation === 'getChatHistoryAround' ||
  operation === 'findChatTranscript' ||
  operation === 'findChatFiles';
export function checkChatReplySize<T>(value: T): T {
  if (new TextEncoder().encode(JSON.stringify(value)).length > maximumChatReplyBytes - 256)
    fail('InvalidInput', 'Chat reply exceeds its delivery limit.');
  return value;
}
/** Project network results explicitly; schemas grant no remote authority. */
export function checkChatOutput<K extends ChatCommand>(
  operation: K,
  value: unknown,
  request: ChatInput<K>,
): ChatOutput<K> {
  const result = decodeChatOutput(operation, value);
  if (operation === 'getChat') {
    const snapshot = result as ChatSnapshot;
    if (snapshot.run && !isSameChatTarget(snapshot.run.stop.target, snapshot.conversation.target))
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
          !isSameChatHost(s.target.host, requestedSession.host) ||
          s.target.actorId !== requestedSession.actorId,
      )
    )
      fail('Incompatible', 'Chat authority changed.');
  }
  if (
    operation === 'getChatHost' &&
    !isSameChatHost(r!.host as ChatHostTarget, q.host as ChatHostTarget)
  )
    fail('Incompatible', 'Chat host changed.');
  const validateTranscript = (transcript: ChatTranscript, target: ChatTarget, id?: string) => {
    if (
      !isSameChatTarget(transcript.source.target, target) ||
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
      data.matches.some((match) => !isSameChatTarget(match.source.target, input.target))
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
    if (actual && !isSameChatTarget(actual, q.target as ChatTarget))
      fail('Incompatible', 'Chat target changed.');
  }
  if (q.requestId && r?.requestId !== undefined && q.requestId !== r.requestId)
    fail('Incompatible', 'Chat request identity changed.');
  if (operation === 'stopChat' && !areJsonValuesEqual(r!.stop, q.stop))
    fail('Incompatible', 'Stop authority changed.');
  return checkChatReplySize(result);
}
