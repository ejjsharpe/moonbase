import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { LiveDoc } from '@earendil-works/pi-durable';
import { Effect } from 'effect';
import type {
  ChatHistoryPage,
  ChatInput,
  ChatOutput,
  ChatSession,
  ChatSnapshot,
  ChatSummary,
  ChatTarget,
} from '@moonbase/contracts/chat';
import {
  ChatAccessError,
  ChatStoreError,
  ChatStoreMismatchError,
  type ChatError,
} from '@moonbase/contracts/chat-errors';
import { isSameChatHost } from '@moonbase/contracts/chat-validation';
import { listConversations, readListedConversation } from '../chat-list/list-chats.ts';
import { Store, cid, getSettings } from '../documents.ts';
import { projectSnapshot, type SnapshotCache } from '../history/chat-snapshot.ts';
import { readHistoryAround } from '../history/history-around.ts';
import { readHistory } from '../history/history-page.ts';
import { decodeStoreOwner } from '../stored-records.ts';
import { findTranscript } from '../transcript/find-transcript.ts';
import { readTranscriptContent } from '../transcript/transcript-content.ts';
import type { Host } from './chat-host.ts';
import { safeError } from './safe-error.ts';

export function getTranscriptContent(host: Host, d: ChatInput<'getChatTranscriptContent'>) {
  return Effect.andThen(
    host.metadata(d.source.target),
    host.read((signal) => readTranscriptContent(host.harness, d, signal)),
  );
}
export function findInTranscript(host: Host, d: ChatInput<'findChatTranscript'>) {
  return Effect.andThen(
    host.metadata(d.target),
    host.read((signal) => findTranscript(host.harness, d, signal)),
  );
}
/** Searches only a chat's own working folder, or one a new chat could be created in. */
export function findFiles(
  host: Host,
  d: ChatInput<'findChatFiles'>,
): Effect.Effect<ChatOutput<'findChatFiles'>, ChatError> {
  const folder =
    'target' in d
      ? Effect.flatMap(host.metadata(d.target), (meta) =>
          Effect.try({ try: () => getSettings(meta).cwd, catch: safeError }),
        )
      : Effect.andThen(host.checkSession(d.session), () => {
          const { approveFolder } = host.config;
          return approveFolder
            ? Effect.as(
                Effect.mapError(approveFolder(d.cwd), (error) => safeError(error)),
                d.cwd,
              )
            : Effect.succeed(d.cwd);
        });
  return Effect.flatMap(folder, (cwd) => host.files.find(cwd, d.query));
}
export function getHistoryAround(host: Host, d: ChatInput<'getChatHistoryAround'>) {
  return Effect.andThen(
    host.metadata(d.target),
    host.read((signal) => readHistoryAround(host.harness, d, signal)),
  );
}
const readStoreOwner = (host: Host) =>
  host.read(async () => decodeStoreOwner(await host.harness.snapshot(Store, 'identity', context)));
export function getChatHost(
  host: Host,
  d: ChatInput<'getChatHost'>,
): Effect.Effect<ChatOutput<'getChatHost'>, ChatError> {
  if (!isSameChatHost(d.host, host.config.host))
    return Effect.fail(new ChatStoreMismatchError({ mismatch: 'other-host' }));
  return Effect.as(readStoreOwner(host), {
    host: { ...host.config.host },
    actorId: host.config.actorId,
    mode: 'local' as const,
  });
}
/** One chat as a listing shows it; undefined when it is missing or not this session's. */
export function readListedChat(
  host: Host,
  session: ChatSession,
  conversationId: string,
): Effect.Effect<ChatSummary | undefined, ChatError> {
  return Effect.andThen(
    host.checkSession(session),
    host.read(() => readListedConversation(host.harness, session, host.identity, conversationId)),
  );
}
export function listChats(
  host: Host,
  d: ChatInput<'listChats'>,
): Effect.Effect<ChatOutput<'listChats'>, ChatError> {
  return Effect.andThen(
    host.checkSession(d.session),
    host.read(() => listConversations(host.harness, d.session, host.identity, d.cursor)),
  );
}
export function getHistory(
  host: Host,
  d: ChatInput<'getChatHistory'>,
): Effect.Effect<ChatHistoryPage, ChatError> {
  return Effect.andThen(
    host.metadata(d.target),
    host.read((signal) =>
      readHistory(host.harness, {
        identity: host.identity,
        target: d.target,
        cursor: d.cursor,
        signal,
      }),
    ),
  );
}
export function readSnapshot(
  host: Host,
  target: ChatTarget,
  cache?: SnapshotCache,
): Effect.Effect<ChatSnapshot, ChatError> {
  return Effect.gen(function* () {
    const meta = yield* host.metadata(target);
    const owner = yield* readStoreOwner(host);
    if (owner.identity !== host.identity)
      return yield* Effect.fail(new ChatAccessError({ refusal: 'store-authority' }));
    if (cache && cache.boundary === undefined) {
      const live = yield* host.read(() =>
        host.harness.snapshot(LiveDoc, cid(target.conversationId), context),
      );
      if (!live) return yield* Effect.fail(new ChatStoreError({ problem: 'live-state' }));
    }
    return yield* projectSnapshot(host.harness, {
      identity: host.identity,
      target,
      conversation: yield* host.summary(target.conversationId, meta),
      pending: meta.pending,
      cache,
    });
  });
}
