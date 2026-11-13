import { areJsonValuesEqual } from '@moonbase/contracts/common';
import type { ChatListState, ChatSnapshot, ChatSummary } from '@moonbase/contracts/chat';
import type { ProviderState } from '@moonbase/contracts/providers';
import type {
  ChatDelta,
  ChatListDelta,
  ProviderSetupDelta,
  SocketDelta,
  SocketSubscriptionKind,
  SocketSubscriptionValue,
} from '@moonbase/contracts/socket';

/**
 * What changed from `previous` to `next`: `null` when nothing did, a delta where one pays, or
 * undefined when only a fresh snapshot describes the change.
 */
export function projectSocketDelta<K extends SocketSubscriptionKind>(
  kind: K,
  previous: SocketSubscriptionValue<K>,
  next: SocketSubscriptionValue<K>,
): SocketDelta<K> | null | undefined {
  if (areJsonValuesEqual(previous, next)) return null;
  // A workspace value is a few numbers, so it is always sent whole.
  if (kind === 'workspace') return undefined;
  if (kind === 'chat')
    return projectChatDelta(previous as ChatSnapshot, next as ChatSnapshot) as SocketDelta<K>;
  if (kind === 'chatList')
    return projectChatListDelta(previous as ChatListState, next as ChatListState) as SocketDelta<K>;
  return projectProviderSetupDelta(
    previous as ProviderState,
    next as ProviderState,
  ) as SocketDelta<K>;
}

/** Deltas cover the running response only: its preview and its transcript parts as they stream. */
function projectChatDelta(previous: ChatSnapshot, next: ChatSnapshot): ChatDelta | undefined {
  const { run: before, ...restBefore } = previous,
    { run: after, ...restAfter } = next;
  if (!before || !after || !areJsonValuesEqual(restBefore, restAfter)) return undefined;
  const {
    text: textBefore,
    truncated: truncatedBefore,
    transcript: liveBefore,
    ...runBefore
  } = before;
  const { text: textAfter, truncated: truncatedAfter, transcript: liveAfter, ...runAfter } = after;
  if (!areJsonValuesEqual(runBefore, runAfter) || !liveBefore !== !liveAfter) return undefined;
  const delta: ChatDelta = {};
  if (textBefore !== textAfter) delta.text = textAfter;
  if (truncatedBefore !== truncatedAfter) delta.truncated = truncatedAfter;
  if (liveBefore && liveAfter) {
    const { parts: partsBefore, nextCursor: cursorBefore, ...sourceBefore } = liveBefore,
      { parts: partsAfter, nextCursor: cursorAfter, ...sourceAfter } = liveAfter;
    if (!areJsonValuesEqual(sourceBefore, sourceAfter) || partsAfter.length < partsBefore.length)
      return undefined;
    const parts: NonNullable<ChatDelta['parts']> = [];
    partsAfter.forEach((part, index) => {
      const old = partsBefore[index];
      if (old && areJsonValuesEqual(old, part)) return;
      if (old) {
        const { text: a, bytes: _a, revision: _b, truncated: _c, ...fieldsBefore } = old,
          { text: b, bytes, revision, truncated, ...fieldsAfter } = part;
        if (b.startsWith(a) && areJsonValuesEqual(fieldsBefore, fieldsAfter)) {
          parts.push({ index, append: b.slice(a.length), bytes, revision, truncated });
          return;
        }
      }
      parts.push({ index, part });
    });
    if (parts.length) delta.parts = parts;
    if (cursorBefore !== cursorAfter) delta.nextCursor = cursorAfter;
  }
  return delta;
}

/** Rows of `next` that differ from `previous`'s row with the same ID. */
const upserted = (previous: readonly ChatSummary[], next: readonly ChatSummary[]) => {
  const before = new Map(previous.map((row) => [row.target.conversationId, row]));
  return next.filter((row) => !areJsonValuesEqual(before.get(row.target.conversationId), row));
};
const ids = (rows: readonly ChatSummary[]) => rows.map((row) => row.target.conversationId);

function projectChatListDelta(previous: ChatListState, next: ChatListState): ChatListDelta {
  const kept = new Set(ids(next.list.conversations));
  const changed = areJsonValuesEqual(previous.changed, next.changed)
    ? {}
    : { changed: { upsert: upserted(previous.changed, next.changed), order: ids(next.changed) } };
  return {
    upsert: upserted(previous.list.conversations, next.list.conversations),
    remove: ids(previous.list.conversations).filter((id) => !kept.has(id)),
    order: ids(next.list.conversations),
    nextCursor: next.list.nextCursor,
    ...changed,
    ...(previous.dropped === next.dropped ? {} : { dropped: next.dropped }),
  };
}

function projectProviderSetupDelta(
  previous: ProviderState,
  next: ProviderState,
): ProviderSetupDelta {
  return {
    ...(areJsonValuesEqual(previous.providers, next.providers)
      ? {}
      : { providers: next.providers }),
    ...(areJsonValuesEqual(previous.flow, next.flow) ? {} : { flow: next.flow }),
  };
}
