import type { ChatSnapshot, ChatSummary } from '@moonbase/contracts/chat';
import type { Pending } from './saved.ts';

/**
 * Why a chat sits in its group: what it last did, that it waits on an unconfirmed Send, that it is
 * idle with nothing new (`idle`), or that you settled it (`settled`).
 */
export type ChatActivityReason =
  | 'unconfirmed'
  | 'failed'
  | 'stopped'
  | 'finished'
  | 'running'
  | 'idle'
  | 'settled';
export type ActiveChat = { chat: ChatSummary; reason: ChatActivityReason; at: string };
export type ChatActivityGroups = {
  /** Ended since you last looked, or a Send that could not be confirmed. */
  ready: ActiveChat[];
  working: ActiveChat[];
  /** Idle chats with nothing new: ones you have seen, or that never ran. */
  idle: ActiveChat[];
  /** Chats you settled, most recently settled first, unless running or unconfirmed. */
  settled: ActiveChat[];
};

/**
 * Orders chats by what they need from you. The open chat's snapshot overrides its listing, which
 * may be a reload old. Each group is newest first: by activity, or for Settled by when you settled
 * it, which is then each row's time.
 */
export function groupChatsByActivity({
  chats,
  seen = [],
  pending = [],
  open,
}: {
  chats: readonly ChatSummary[];
  seen?: readonly { conversationId: string; at: string }[];
  pending?: readonly Pending[];
  open?: Pick<ChatSnapshot, 'conversation' | 'state' | 'run'> | null;
}): ChatActivityGroups {
  const looked = new Map(seen.map((item) => [item.conversationId, Date.parse(item.at)]));
  const unconfirmed = new Set(
    pending.flatMap((item) =>
      item.operation === 'sendChat' ? [item.input.target.conversationId] : [],
    ),
  );
  const groups: ChatActivityGroups = { ready: [], working: [], idle: [], settled: [] };
  for (const chat of chats) {
    const id = chat.target.conversationId;
    const at = chat.activity?.at ?? chat.createdAt;
    let state = chat.activity?.state ?? 'idle',
      settledAt = chat.settledAt;
    if (open?.conversation.target.conversationId === id) {
      settledAt = open.conversation.settledAt;
      if (open.run) state = 'running';
      else if (open.state === 'stopped' || open.state === 'failed' || open.state === 'idle')
        state = open.state;
    }
    const unseen = (looked.get(id) ?? -Infinity) < Date.parse(at);
    let reason: ChatActivityReason = 'idle';
    if (unconfirmed.has(id)) reason = 'unconfirmed';
    else if (state === 'running') reason = 'running';
    else if (settledAt) reason = 'settled';
    else if (unseen && (state === 'failed' || state === 'stopped')) reason = state;
    // A chat that never ran has nothing to look at yet.
    else if (unseen && at !== chat.createdAt) reason = 'finished';
    const entry = { chat, reason, at: reason === 'settled' ? settledAt! : at };
    if (reason === 'running') groups.working.push(entry);
    else if (reason === 'idle') groups.idle.push(entry);
    else if (reason === 'settled') groups.settled.push(entry);
    else groups.ready.push(entry);
  }
  const newest = (a: ActiveChat, b: ActiveChat) => Date.parse(b.at) - Date.parse(a.at);
  groups.ready.sort(newest);
  groups.working.sort(newest);
  groups.idle.sort(newest);
  groups.settled.sort(newest);
  return groups;
}
