import { chatContentChunkBytes } from './chat.ts';
import type { ChatListState, ChatSnapshot, ChatSummary } from './chat.ts';
import { IncompatibleHostError } from './host-errors.ts';
import type { ProviderState } from './providers.ts';
import type * as Contracts from './watch-schema.ts';

// A chat, chat list or provider setup watch over RPC sends its first value whole, then deltas
// from the value it last sent where one pays (D10: no replay, takeover or coalescing).

/** A delta's JSON is at most this; a larger change is sent as a fresh value. */
export const watchDeltaBytes = chatContentChunkBytes;

export type WatchKind = 'chat' | 'chatList' | 'providerSetup';
/** The value each kind of watch describes. */
export type WatchValue<K extends WatchKind> = {
  chat: ChatSnapshot;
  chatList: ChatListState;
  providerSetup: ProviderState;
}[K];
export type ChatDelta = typeof Contracts.ChatDeltaSchema.Type;
export type ChatListDelta = typeof Contracts.ChatListDeltaSchema.Type;
export type ProviderSetupDelta = typeof Contracts.ProviderSetupDeltaSchema.Type;
export type WatchDelta<K extends WatchKind> = {
  chat: ChatDelta;
  chatList: ChatListDelta;
  providerSetup: ProviderSetupDelta;
}[K];

/** A delta that does not apply to the value before it: the daemon sent an invalid update. */
const inapplicable = (): never => {
  throw new IncompatibleHostError({ reason: 'invalid-update' });
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
    list: {
      conversations: pick(rows, delta.order),
      nextCursor: delta.nextCursor,
    },
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
export function applyWatchDelta<K extends WatchKind>(
  kind: K,
  value: WatchValue<K>,
  delta: WatchDelta<K>,
): WatchValue<K> {
  if (kind === 'chat') return applyChatDelta(value as ChatSnapshot, delta as ChatDelta) as never;
  if (kind === 'chatList')
    return applyChatListDelta(value as ChatListState, delta as ChatListDelta) as never;
  return applyProviderSetupDelta(value as ProviderState, delta as ProviderSetupDelta) as never;
}
