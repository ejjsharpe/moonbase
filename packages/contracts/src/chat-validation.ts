import { Effect } from 'effect';
import { areJsonValuesEqual } from './common.ts';
import { InvalidChatRequestError } from './chat-errors.ts';
import { IncompatibleHostError } from './host-errors.ts';
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
/** Reads a caller may abandon; every other command runs to completion once dispatched. */
export const isCancellableChatRead = (operation: ChatCommand) =>
  operation === 'getChatTranscriptContent' ||
  operation === 'getChatHistoryAround' ||
  operation === 'findChatTranscript' ||
  operation === 'findChatFiles';
const replyLimit = () => new InvalidChatRequestError({ problem: 'reply-limit' });
export function checkChatReplySize<T>(value: T): T {
  if (new TextEncoder().encode(JSON.stringify(value)).length > maximumChatReplyBytes - 256)
    throw replyLimit();
  return value;
}
/**
 * Whether a decoded chat reply answers its request: it echoes what the request named and stays
 * within the host and actor the request is for. Schemas grant no remote authority.
 */
function answersChatRequest<K extends ChatCommand>(
  operation: K,
  result: ChatOutput<K>,
  request: ChatInput<K>,
): boolean {
  if (operation === 'getChat') {
    const snapshot = result as ChatSnapshot;
    if (snapshot.run && !isSameChatTarget(snapshot.run.stop.target, snapshot.conversation.target))
      return false;
  }
  const r = result as Record<string, unknown> | null,
    q = request as Record<string, unknown>;
  const requestedSession = q.session as ChatSession | undefined;
  if (operation === 'findChatFiles') {
    if (r!.query !== q.query) return false;
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
      return false;
  }
  if (
    operation === 'getChatHost' &&
    !isSameChatHost(r!.host as ChatHostTarget, q.host as ChatHostTarget)
  )
    return false;
  const isTranscriptOf = (transcript: ChatTranscript, target: ChatTarget, id?: string) =>
    isSameChatTarget(transcript.source.target, target) &&
    (id === undefined ||
      (transcript.source.kind === 'entry' && transcript.source.entryId === id)) &&
    new Set(transcript.parts.map((part) => part.partId)).size === transcript.parts.length;
  if (
    operation === 'getChat' ||
    operation === 'getChatHistoryAround' ||
    operation === 'getChatHistory'
  ) {
    const target = q.target as ChatTarget;
    for (const entry of r!.entries as ChatSnapshot['entries'])
      if (entry.transcript && !isTranscriptOf(entry.transcript, target, entry.id)) return false;
    if (operation === 'getChat') {
      const run = (result as ChatSnapshot).run;
      if (run?.transcript) {
        if (!isTranscriptOf(run.transcript, target)) return false;
        const source = run.transcript.source;
        if (
          source.kind !== 'live' ||
          source.submissionId !== run.stop.submissionId ||
          source.taskId !== run.stop.taskId
        )
          return false;
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
      return false;
  }
  if (operation === 'getChatHistoryAround') {
    if (r!.entryId !== q.entryId || r!.cursor !== (q.cursor ?? null)) return false;
  }
  if (operation === 'getChatTranscriptContent') {
    const data = result as ChatOutput<'getChatTranscriptContent'>;
    const input = request as ChatInput<'getChatTranscriptContent'>;
    if (!areJsonValuesEqual(data.source, input.source) || data.cursor !== (input.cursor ?? null))
      return false;
    if (data.kind === 'manifest') {
      if (input.selection) return false;
      if (!isTranscriptOf(data, input.source.target)) return false;
    } else {
      if (!input.selection || !areJsonValuesEqual(data.selection, input.selection)) return false;
    }
  }
  if (q.target && r) {
    const actual =
      operation === 'getChat'
        ? (r.conversation as ChatSummary).target
        : (r.target as ChatTarget | undefined);
    if (actual && !isSameChatTarget(actual, q.target as ChatTarget)) return false;
  }
  if (q.requestId && r?.requestId !== undefined && q.requestId !== r.requestId) return false;
  if (operation === 'stopChat' && !areJsonValuesEqual(r!.stop, q.stop)) return false;
  return true;
}

/**
 * Checks a chat reply, decoded where it arrived, answers its request and fits the reply limit:
 * refused `IncompatibleHostError` (`invalid-reply`) or `InvalidChatRequestError` (`reply-limit`).
 */
export const checkChatOutput = <K extends ChatCommand>(
  operation: K,
  output: ChatOutput<K>,
  request: ChatInput<K>,
): Effect.Effect<ChatOutput<K>, IncompatibleHostError | InvalidChatRequestError> =>
  Effect.suspend(
    (): Effect.Effect<ChatOutput<K>, IncompatibleHostError | InvalidChatRequestError> =>
      answersChatRequest(operation, output, request)
        ? Effect.try({ try: () => checkChatReplySize(output), catch: replyLimit })
        : Effect.fail(new IncompatibleHostError({ reason: 'invalid-reply' })),
  );
