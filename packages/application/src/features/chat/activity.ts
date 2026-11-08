import type { ChatSnapshot, ChatSummary } from '@moonbase/contracts/chat';
import type { Pending } from './saved.ts';

/** Why a chat sits in its group: what it last did, or that it waits on an unconfirmed Send. */
export type ChatActivityReason =
  | 'unconfirmed'
  | 'failed'
  | 'stopped'
  | 'finished'
  | 'running'
  | 'settled';
export type ActiveChat = { chat: ChatSummary; reason: ChatActivityReason; at: string };
export type ChatActivityGroups = {
  /** Ended since you last looked, or a Send that could not be confirmed. */
  ready: ActiveChat[];
  working: ActiveChat[];
  /** Everything else: idle chats you have seen, or that never ran. */
  settled: ActiveChat[];
};

/**
 * Orders chats by what they need from you. The open chat's snapshot overrides its listing, which
 * may be a reload old. A pending Send is unconfirmed unless `dispatching` names it as still being
 * sent (`ChatState.dispatching`). Each group is newest activity first.
 */
export function groupChatsByActivity({
  chats,
  seen = [],
  pending = [],
  dispatching = [],
  open,
}: {
  chats: readonly ChatSummary[];
  seen?: readonly { conversationId: string; at: string }[];
  pending?: readonly Pending[];
  dispatching?: readonly string[];
  open?: Pick<ChatSnapshot, 'conversation' | 'state' | 'run'> | null;
}): ChatActivityGroups {
  const looked = new Map(seen.map((item) => [item.conversationId, Date.parse(item.at)]));
  const sending = new Set(dispatching);
  const unconfirmed = new Set(
    pending.flatMap((item) =>
      item.operation === 'sendChat' && !sending.has(item.input.requestId)
        ? [item.input.target.conversationId]
        : [],
    ),
  );
  const groups: ChatActivityGroups = { ready: [], working: [], settled: [] };
  for (const chat of chats) {
    const id = chat.target.conversationId;
    const at = chat.activity?.at ?? chat.createdAt;
    let state = chat.activity?.state ?? 'idle';
    if (open?.conversation.target.conversationId === id) {
      if (open.run) state = 'running';
      else if (open.state === 'stopped' || open.state === 'failed' || open.state === 'idle')
        state = open.state;
    }
    const unseen = (looked.get(id) ?? -Infinity) < Date.parse(at);
    let reason: ChatActivityReason = 'settled';
    if (unconfirmed.has(id)) reason = 'unconfirmed';
    else if (state === 'running') reason = 'running';
    else if (unseen && (state === 'failed' || state === 'stopped')) reason = state;
    // A chat that never ran has nothing to look at yet.
    else if (unseen && at !== chat.createdAt) reason = 'finished';
    const entry = { chat, reason, at };
    if (reason === 'running') groups.working.push(entry);
    else if (reason === 'settled') groups.settled.push(entry);
    else groups.ready.push(entry);
  }
  const newest = (a: ActiveChat, b: ActiveChat) => Date.parse(b.at) - Date.parse(a.at);
  groups.ready.sort(newest);
  groups.working.sort(newest);
  groups.settled.sort(newest);
  return groups;
}
