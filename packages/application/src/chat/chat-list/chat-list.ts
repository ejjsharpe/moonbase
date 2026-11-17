import type { ChatListState, ChatSummary } from '@moonbase/contracts/chat';
import { isSameTarget } from '../drafts/drafts.ts';

/** Pages a listing reads, so a chat that is active again is listed however long ago it started. */
export const chatListPages = 16;
/** Most pages a background reload reads again; older chats Show older added past them stay as listed. */
export const chatReloadPages = 64;

/** The chat list on screen. */
export type ChatListShown = {
  chats: ChatSummary[];
  /** The cursor Show older continues from, or null at the end. */
  nextChats: string | null;
};

/** `chats` with each chat once, at its first place. */
export const dedupeChats = (chats: readonly ChatSummary[]) => [
  ...new Map(chats.map((chat) => [chat.target.conversationId, chat])).values(),
];

/**
 * Merges a fresh listing into the one on screen. Chats are never removed, so a chat the listing
 * did not return (one past its pages, or one created while it read) stays, after the chat it
 * followed on screen.
 */
export function keepUnreachedChats(shown: readonly ChatSummary[], listed: readonly ChatSummary[]) {
  const reached = new Set(listed.map((chat) => chat.target.conversationId));
  const following = new Map<string | null, ChatSummary[]>();
  let anchor: string | null = null;
  for (const chat of shown) {
    const id = chat.target.conversationId;
    if (reached.has(id)) anchor = id;
    else following.set(anchor, [...(following.get(anchor) ?? []), chat]);
  }
  return [
    ...(following.get(null) ?? []),
    ...listed.flatMap((chat) => [chat, ...(following.get(chat.target.conversationId) ?? [])]),
  ];
}

/**
 * A reload of `listed` (which read `pages` pages, ending at `next`) merged into the list shown.
 * The list reaches past the pages read only when a chat it did not reach comes last; then it keeps
 * its cursor and page count.
 */
export function mergeListing(
  shown: ChatListShown,
  listed: { chats: readonly ChatSummary[]; next: string | null; pages: number },
): ChatListShown & { pages: number | undefined } {
  const kept = keepUnreachedChats(shown.chats, listed.chats);
  const past = kept.length > 0 && !listed.chats.includes(kept.at(-1)!);
  return {
    chats: dedupeChats(kept),
    nextChats: past ? shown.nextChats : listed.next,
    pages: past ? undefined : listed.pages,
  };
}

/**
 * A watch page merged into the list shown: its first page, keeping chats it did not reach, with
 * listed chats past it replaced by their changed rows.
 */
export function mergeWatchPage(
  shown: ChatListShown,
  { list: page, changed }: ChatListState,
): ChatListShown & { pages: number | undefined } {
  const merged = mergeListing(shown, {
    chats: page.conversations,
    next: page.nextCursor,
    pages: 1,
  });
  const rows = new Map(changed.map((chat) => [chat.target.conversationId, chat]));
  return {
    ...merged,
    chats: merged.chats.map((chat) => rows.get(chat.target.conversationId) ?? chat),
  };
}

/** The list with a settled chat's row from the host's reply, keeping its listed activity. */
export function settleRow(chats: readonly ChatSummary[], summary: ChatSummary): ChatSummary[] {
  return chats.map((chat) => {
    if (!isSameTarget(chat.target, summary.target)) return chat;
    return { ...summary, ...(chat.activity ? { activity: chat.activity } : {}) };
  });
}

/** The list with a newly created chat first. */
export const addCreatedChat = (chats: readonly ChatSummary[], created: ChatSummary) => [
  created,
  ...chats.filter((chat) => !isSameTarget(chat.target, created.target)),
];
