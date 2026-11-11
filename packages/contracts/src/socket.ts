import { ApplicationError } from './errors.ts';
import { chatContentChunkBytes, maximumChatReplyBytes } from './chat.ts';
import type { ChatListState, ChatSnapshot, ChatSummary } from './chat.ts';
import type { ProviderState } from './providers.ts';
import type * as Contracts from './socket-schema.ts';

/** Where a daemon that advertises `socket-v1` upgrades its one WebSocket per client. */
export const socketPath = '/v2/socket';
/** HMAC domain of the WebSocket's frame keys; it cannot be reflected into the HTTP protocol's. */
export const socketDomain = 'moonbase-daemon-socket-v1';
/**
 * Bounds of one WebSocket connection. Request deadlines are the operations' own; heartbeats and
 * idle timeouts only keep the connection itself alive.
 */
export const socketLimits = {
  /** A whole WebSocket message: its 32-byte MAC and JSON body. */
  frameBytes: 256 * 1024,
  /** A reply's or snapshot's JSON before chunking, as an HTTP reply's. */
  payloadBytes: maximumChatReplyBytes,
  /** Raw bytes per chunk of a reply or snapshot. */
  chunkBytes: chatContentChunkBytes,
  /** A delta's JSON; a larger change is sent as a fresh snapshot. */
  deltaBytes: chatContentChunkBytes,
  /** Subscriptions open on one connection, of every kind. */
  subscriptions: 64,
  /** Requests in flight on one connection. */
  requests: 32,
  /** Replies and refusals waiting to be written; a client that leaves more unread is dropped. */
  queuedReplies: 64,
  /** The server's bound on the hello arriving after its challenge. */
  handshakeMs: 5_000,
  /**
   * The client's bound on connecting through to the welcome (TCP, an SSH forward's channel, the
   * upgrade, challenge and hello), the HTTP stream's establishment budget.
   */
  connectMs: 20_000,
  /** A side that has sent nothing for this long sends a heartbeat. */
  heartbeatMs: 10_000,
  /** A side that has received nothing for this long closes the connection. */
  idleMs: 30_000,
  /** Bytes a connection's socket may buffer before the server stops reading and writing. */
  outboundBytes: 1024 * 1024,
  /** A client that reads nothing of a full buffer for this long is disconnected. */
  drainMs: 20_000,
  /** How long a disconnected subscription's updates stay available to resume. */
  resumeMs: 60_000,
  /** Disconnected subscriptions kept for resuming, across every connection. */
  resumable: 64,
  /** Deltas a subscription keeps for resuming, and their JSON in all. */
  historyUpdates: 64,
  historyBytes: 256 * 1024,
  /** Kept deltas' JSON across every subscription; the oldest subscriptions' go first. */
  historyTotalBytes: 16 * 1024 * 1024,
} as const;

export type SocketSubscriptionKind = 'chat' | 'chatList' | 'providerSetup';
/** What each subscription kind targets and the value its updates describe. */
export type SocketSubscriptionTarget<K extends SocketSubscriptionKind> = {
  chat: typeof Contracts.ChatTargetSchema.Type;
  chatList: typeof Contracts.ChatSessionSchema.Type;
  providerSetup: typeof Contracts.ProviderSetupTargetSchema.Type;
}[K];
export type SocketSubscriptionValue<K extends SocketSubscriptionKind> = {
  chat: ChatSnapshot;
  chatList: ChatListState;
  providerSetup: ProviderState;
}[K];
export type ChatDelta = typeof Contracts.ChatDeltaSchema.Type;
export type ChatListDelta = typeof Contracts.ChatListDeltaSchema.Type;
export type ProviderSetupDelta = typeof Contracts.ProviderSetupDeltaSchema.Type;
export type SocketDelta<K extends SocketSubscriptionKind> = {
  chat: ChatDelta;
  chatList: ChatListDelta;
  providerSetup: ProviderSetupDelta;
}[K];
export type SocketClientMessage = typeof Contracts.SocketClientMessageSchema.Type;
export type SocketServerMessage = typeof Contracts.SocketServerMessageSchema.Type;
export type SocketChallenge = typeof Contracts.SocketChallengeSchema.Type;

const inapplicable = (): never => {
  throw new ApplicationError({
    code: 'Incompatible',
    message: 'Subscription update does not apply to the previous state.',
  });
};
/**
 * The running response after `delta`: its preview text replaced, transcript parts' text appended
 * or parts replaced and added. Everything else in the snapshot is unchanged.
 */
export function applyChatDelta(snapshot: ChatSnapshot, delta: ChatDelta): ChatSnapshot {
  const run = snapshot.run ?? inapplicable();
  const next = {
    ...run,
    ...(delta.text !== undefined ? { text: delta.text } : {}),
    ...(delta.truncated !== undefined ? { truncated: delta.truncated } : {}),
  };
  if (delta.parts || delta.nextCursor !== undefined) {
    const transcript = run.transcript ?? inapplicable(),
      parts = [...transcript.parts];
    for (const change of delta.parts ?? []) {
      if (change.index > parts.length) inapplicable();
      if ('part' in change) parts[change.index] = change.part;
      else {
        const part = parts[change.index] ?? inapplicable();
        parts[change.index] = {
          ...part,
          text: part.text + change.append,
          bytes: change.bytes,
          revision: change.revision,
          truncated: change.truncated,
        };
      }
    }
    next.transcript = {
      ...transcript,
      parts,
      ...(delta.nextCursor !== undefined ? { nextCursor: delta.nextCursor } : {}),
    };
  }
  return { ...snapshot, run: next };
}
const byId = (rows: readonly ChatSummary[], upsert: readonly ChatSummary[] = []) =>
  new Map<string, ChatSummary>([...rows, ...upsert].map((row) => [row.target.conversationId, row]));
/** `rows` in `order`; refuses an ID it lacks or names twice. */
const pick = (rows: Map<string, ChatSummary>, order: readonly string[]) => {
  if (new Set(order).size !== order.length) inapplicable();
  return order.map((id) => rows.get(id) ?? inapplicable());
};
/**
 * The chat list after `delta`: page rows upserted and removed, in the delta's order, and changed
 * chats past the page upserted, in theirs.
 */
export function applyChatListDelta(state: ChatListState, delta: ChatListDelta): ChatListState {
  const rows = byId(state.list.conversations);
  for (const id of delta.remove) if (!rows.delete(id)) inapplicable();
  for (const row of delta.upsert) rows.set(row.target.conversationId, row);
  if (rows.size !== delta.order.length) inapplicable();
  return {
    list: { conversations: pick(rows, delta.order), nextCursor: delta.nextCursor },
    changed: delta.changed
      ? pick(byId(state.changed, delta.changed.upsert), delta.changed.order)
      : state.changed,
    dropped: delta.dropped ?? state.dropped,
  };
}
/** Provider setup after `delta`: the fields it names replaced. */
export function applyProviderSetupDelta(
  state: ProviderState,
  delta: ProviderSetupDelta,
): ProviderState {
  return {
    providers: delta.providers ?? state.providers,
    flow: delta.flow !== undefined ? delta.flow : state.flow,
  };
}
/** Applies a decoded delta of `kind`; the caller decodes the result as that kind's value. */
export function applySocketDelta<K extends SocketSubscriptionKind>(
  kind: K,
  value: SocketSubscriptionValue<K>,
  delta: SocketDelta<K>,
): SocketSubscriptionValue<K> {
  if (kind === 'chat') return applyChatDelta(value as ChatSnapshot, delta as ChatDelta) as never;
  if (kind === 'chatList')
    return applyChatListDelta(value as ChatListState, delta as ChatListDelta) as never;
  return applyProviderSetupDelta(value as ProviderState, delta as ProviderSetupDelta) as never;
}
