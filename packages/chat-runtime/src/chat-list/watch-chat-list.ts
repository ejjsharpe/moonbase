import { Effect, Stream } from 'effect';
import type { ChatError } from '@moonbase/contracts/chat-errors';
import {
  chatPageSize,
  maximumChatReplyBytes,
  type ChatListUpdate,
  type ChatSession,
  type ChatSummary,
} from '@moonbase/contracts/chat';
import type { Host } from '../commands/chat-host.ts';
import { readListedChat, listChats } from '../commands/chat-reads.ts';
import { followChanges, listenToPi, listenToPubSub } from '../commands/harness-changes.ts';
import { listedChanges } from '../commands/publications.ts';
import { watchError } from '../commands/safe-error.ts';

/**
 * The chat list's first page and the chats past it that changed while watching, read again after
 * each change. Changed chats beyond `chatPageSize`, or past the reply limit, go least recently
 * changed first and count as dropped.
 */
export function watchChatListState(
  host: Host,
  session: ChatSession,
): Stream.Stream<ChatListUpdate, ChatError> {
  return Stream.suspend(() => {
    const touched = new Set<string>(),
      // In the order they last changed, least recent first.
      changed = new Map<string, ChatSummary>();
    let dropped = 0;
    const touch = (conversationIds: readonly string[], refresh: () => void) => {
      for (const id of conversationIds) touched.add(id);
      if (conversationIds.length) refresh();
    };
    const read = Effect.gen(function* () {
      const ids = [...touched];
      touched.clear();
      const list = yield* listChats(host, { session });
      const listed = new Set(list.conversations.map((row) => row.target.conversationId));
      for (const id of ids) {
        changed.delete(id);
        const row = listed.has(id) ? undefined : yield* readListedChat(host, session, id);
        if (row) changed.set(id, row);
      }
      for (const id of listed) changed.delete(id);
      const state = () => ({ list, changed: [...changed.values()], dropped, reset: false });
      while (
        changed.size > chatPageSize ||
        (changed.size && Buffer.byteLength(JSON.stringify(state())) > maximumChatReplyBytes)
      ) {
        changed.delete(changed.keys().next().value!);
        dropped++;
      }
      return state();
    });
    return followChanges((refresh) =>
      Effect.andThen(
        listenToPi(() =>
          host.harness.subscribeCommits((publication) =>
            touch(listedChanges(publication), refresh),
          ),
        ),
        listenToPubSub(host.statuses, (conversationId) => touch([String(conversationId)], refresh)),
      ),
    ).pipe(Stream.mapEffect(() => Effect.mapError(read, watchError)));
  });
}
