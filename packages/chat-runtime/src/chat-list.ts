import type { Stream } from 'effect';
import type { ApplicationError } from '@moonbase/contracts/workspace';
import {
  chatPageSize,
  maximumChatReplyBytes,
  type ChatListUpdate,
  type ChatSession,
  type ChatSummary,
} from '@moonbase/contracts/chat';
import { readOnChange } from '@moonbase/effect/changes';
import type { Host } from './commands.ts';

/**
 * The chat list's first page and the chats past it that changed while watching, read again after
 * each change. Changed chats beyond `chatPageSize`, or past the reply limit, go least recently
 * changed first and count as dropped.
 */
export function watchChatListState(
  host: Host,
  session: ChatSession,
): Stream.Stream<ChatListUpdate, ApplicationError> {
  const touched = new Set<string>(),
    // In the order they last changed, least recent first.
    changed = new Map<string, ChatSummary>();
  let dropped = 0;
  return readOnChange(
    (listener) =>
      host.subscribeChatList((conversationIds) => {
        for (const id of conversationIds) touched.add(id);
        listener();
      }),
    async () => {
      const ids = [...touched];
      touched.clear();
      const list = await host.list({ session });
      const listed = new Set(list.conversations.map((row) => row.target.conversationId));
      for (const id of ids) {
        changed.delete(id);
        const row = listed.has(id) ? undefined : await host.listed(session, id);
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
    },
  );
}
