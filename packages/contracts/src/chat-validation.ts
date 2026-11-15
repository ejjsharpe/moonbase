import { areJsonValuesEqual } from './common.ts';
import { InvalidChatRequestError } from './chat-errors.ts';
import { IncompatibleHostError } from './host-errors.ts';
import { decodeChatOutput } from './chat-schema.ts';
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
import type { ChatHostTarget } from './host.ts';

// Chat identity and authority checks. A client checks each reply once, where it arrives from the
// wire; inside a process typed values are trusted.
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
    throw new InvalidChatRequestError({ problem: 'reply-limit' });
  return value;
}
const invalidReply = () => new IncompatibleHostError({ reason: 'invalid-reply' });
/** Decodes a chat reply from the wire and checks it answers the request; schemas grant no remote authority. */
export function checkChatOutput<K extends ChatCommand>(
  operation: K,
  value: unknown,
  request: ChatInput<K>,
): ChatOutput<K> {
  const result = decodeChatOutput(operation, value);
  if (operation === 'getChat') {
    const snapshot = result as ChatSnapshot;
    if (snapshot.run && !isSameChatTarget(snapshot.run.stop.target, snapshot.conversation.target))
      throw invalidReply();
  }
  const r = result as Record<string, unknown> | null,
    q = request as Record<string, unknown>;
  const requestedSession = q.session as ChatSession | undefined;
  if (operation === 'findChatFiles') {
    if (r!.query !== q.query) throw invalidReply();
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
      throw invalidReply();
  }
  if (
    operation === 'getChatHost' &&
    !isSameChatHost(r!.host as ChatHostTarget, q.host as ChatHostTarget)
  )
    throw invalidReply();
  const validateTranscript = (transcript: ChatTranscript, target: ChatTarget, id?: string) => {
    if (
      !isSameChatTarget(transcript.source.target, target) ||
      (id !== undefined && (transcript.source.kind !== 'entry' || transcript.source.entryId !== id))
    )
      throw invalidReply();
    if (new Set(transcript.parts.map((part) => part.partId)).size !== transcript.parts.length)
      throw invalidReply();
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
          throw invalidReply();
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
      throw invalidReply();
  }
  if (operation === 'getChatHistoryAround') {
    if (r!.entryId !== q.entryId || r!.cursor !== (q.cursor ?? null)) throw invalidReply();
  }
  if (operation === 'getChatTranscriptContent') {
    const data = result as ChatOutput<'getChatTranscriptContent'>;
    const input = request as ChatInput<'getChatTranscriptContent'>;
    if (!areJsonValuesEqual(data.source, input.source) || data.cursor !== (input.cursor ?? null))
      throw invalidReply();
    if (data.kind === 'manifest') {
      if (input.selection) throw invalidReply();
      validateTranscript(data, input.source.target);
    } else {
      if (!input.selection || !areJsonValuesEqual(data.selection, input.selection))
        throw invalidReply();
    }
  }
  if (q.target && r) {
    const actual =
      operation === 'getChat'
        ? (r.conversation as ChatSummary).target
        : (r.target as ChatTarget | undefined);
    if (actual && !isSameChatTarget(actual, q.target as ChatTarget)) throw invalidReply();
  }
  if (q.requestId && r?.requestId !== undefined && q.requestId !== r.requestId)
    throw invalidReply();
  if (operation === 'stopChat' && !areJsonValuesEqual(r!.stop, q.stop)) throw invalidReply();
  return checkChatReplySize(result);
}
