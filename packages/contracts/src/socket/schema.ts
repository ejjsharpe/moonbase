import { ApplicationError } from '../errors/schema.ts';
import {
  chatContentChunkBytes,
  maximumChatReplyBytes,
  type ChatListState,
  type ChatSnapshot,
  type ChatSummary,
  chatManifestPageSize,
  chatPageSize,
  chatPreviewBytes,
  ChatIdentifierSchema,
  ChatHostTargetSchema,
  ChatLiveTranscriptPartSchema,
  ChatSessionSchema,
  ChatSnapshotSchema,
  ChatSummarySchema,
  ChatTargetSchema,
  chatOutputSchemas,
  chatReplyErrorCodes,
} from '../chat/schema.ts';
import { type ProviderState, ProviderStateSchema } from '../providers/schema.ts';
import {
  type WorkspaceWatchValue,
  type WorkspaceWatchTarget,
  WorkspaceWatchTargetSchema,
  WorkspaceWatchValueSchema,
} from '../workspace/host-schema.ts';
import * as Schema from 'effect/Schema';
import { array, optional, struct } from '../shared/schema.ts';
import { chatProtocolVersion, ChatHostHealthSchema } from '../host/schema.ts';

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
  /**
   * Raw bytes per chunk of a reply, snapshot or request: base64 and the message around it stay
   * well within a frame.
   */
  chunkBytes: 128 * 1024,
  /** A delta's JSON; a larger change is sent as a fresh snapshot. */
  deltaBytes: chatContentChunkBytes,
  /** Subscriptions open on one connection, of every kind. */
  subscriptions: 64,
  /** Requests in flight on one connection. */
  requests: 32,
  /**
   * Chat and daemon replies, refusals and subscription errors waiting to be written; a client that
   * leaves more unread is dropped.
   */
  queuedReplies: 64,
  /** Workspace requests and replies: JSON before chunking, as one operation's bound. */
  workspaceRequestBytes: 16 * 1024 * 1024,
  workspaceReplyBytes: 16 * 1024 * 1024,
  /**
   * Chunked request input in flight on one connection: a request that would pass it is read,
   * discarded and refused `Unavailable`.
   */
  workspaceInFlightBytes: 32 * 1024 * 1024,
  /** Encoded workspace replies waiting to be written; while more are, workspace requests are refused `Unavailable`. */
  workspaceQueuedBytes: 64 * 1024 * 1024,
  /** Workspace subscriptions on one connection, apart from `subscriptions`. */
  workspaceSubscriptions: 64,
  /** Workspace requests a client keeps in flight, leaving room for chat below `requests`. */
  workspaceRequests: 16,
  /** Further places only `saveStatus` and `operationStatus` use, so a wedged host cannot block them. */
  workspaceStatusRequests: 2,
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

export type SocketSubscriptionKind = 'chat' | 'chatList' | 'providerSetup' | 'workspace';
/** What each subscription kind targets and the value its updates describe. */
export type SocketSubscriptionTarget<K extends SocketSubscriptionKind> = {
  chat: typeof ChatTargetSchema.Type;
  chatList: typeof ChatSessionSchema.Type;
  providerSetup: typeof ProviderSetupTargetSchema.Type;
  workspace: WorkspaceWatchTarget;
}[K];
export type SocketSubscriptionValue<K extends SocketSubscriptionKind> = {
  chat: ChatSnapshot;
  chatList: ChatListState;
  providerSetup: ProviderState;
  workspace: WorkspaceWatchValue;
}[K];
export type ChatDelta = typeof ChatDeltaSchema.Type;
export type ChatListDelta = typeof ChatListDeltaSchema.Type;
export type ProviderSetupDelta = typeof ProviderSetupDeltaSchema.Type;
/** A workspace value is small and always resent whole, so it has no deltas. */
export type SocketDelta<K extends SocketSubscriptionKind> = {
  chat: ChatDelta;
  chatList: ChatListDelta;
  providerSetup: ProviderSetupDelta;
  workspace: never;
}[K];
export type SocketClientMessage = typeof SocketClientMessageSchema.Type;
export type SocketServerMessage = typeof SocketServerMessageSchema.Type;
export type SocketChallenge = typeof SocketChallengeSchema.Type;

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
export function applySocketDelta<K extends SocketSubscriptionKind>(
  kind: K,
  value: SocketSubscriptionValue<K>,
  delta: SocketDelta<K>,
): SocketSubscriptionValue<K> {
  if (kind === 'chat') return applyChatDelta(value as ChatSnapshot, delta as ChatDelta) as never;
  if (kind === 'chatList')
    return applyChatListDelta(value as ChatListState, delta as ChatListDelta) as never;
  if (kind === 'workspace') return inapplicable();
  return applyProviderSetupDelta(value as ProviderState, delta as ProviderSetupDelta) as never;
}

export { ChatSessionSchema, ChatTargetSchema } from '../chat/schema.ts';

const unicode = Schema.String.check(Schema.makeFilter((value) => !/[\ud800-\udfff]/u.test(value)));
const bytes = (limit: number) =>
  unicode.check(
    Schema.makeFilter(
      (value) => !value.includes('\0') && new TextEncoder().encode(value).length <= limit,
    ),
  );
const count = (maximum: number) => Schema.Int.check(Schema.isBetween({ minimum: 0, maximum }));
const sequence = count(Number.MAX_SAFE_INTEGER);
/**
 * One chunk of a chunked payload: canonical base64 of 1 to `socketLimits.chunkBytes` bytes.
 * Decoding and encoding it again gives the same text only when it has no other characters, its
 * padding is exact and the bits the padding leaves unused are zero.
 */
const SocketChunkDataSchema = Schema.String.check(
  Schema.makeFilter((value) => {
    if (!value || value.length % 4 || value.length > Math.ceil(socketLimits.chunkBytes / 3) * 4)
      return false;
    try {
      const bytes = atob(value);
      return bytes.length <= socketLimits.chunkBytes && btoa(bytes) === value;
    } catch {
      return false;
    }
  }),
);
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const cursor = bytes(1024).check(Schema.makeFilter((value) => !!value.trim()));
/** 32 random bytes in canonical base64url: challenges, nonces and subscription IDs. */
export const SocketNonceSchema = Schema.String.check(
  // The last of 43 characters holds 4 bits of the 32nd byte and 2 zero bits.
  Schema.isPattern(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
);
/** A request's ID on its connection, which its reply carries. */
export const SocketRequestIdSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/));
export const ProviderSetupTargetSchema = struct({
  host: ChatHostTargetSchema,
  ownerId: ChatIdentifierSchema,
});

/** The running response's changes: preview text replaced, parts' text appended or parts replaced. */
export const ChatDeltaSchema = struct({
  text: optional(bytes(chatPreviewBytes)),
  truncated: optional(Schema.Boolean),
  parts: optional(
    array(
      Schema.Union([
        struct({
          index: count(chatManifestPageSize - 1),
          append: unicode,
          bytes: sequence,
          revision: digest,
          truncated: Schema.Boolean,
        }),
        struct({ index: count(chatManifestPageSize - 1), part: ChatLiveTranscriptPartSchema }),
      ]),
    ).check(Schema.isMaxLength(chatManifestPageSize)),
  ),
  nextCursor: optional(Schema.NullOr(cursor)),
});
const rows = array(ChatSummarySchema).check(Schema.isMaxLength(chatPageSize));
const ids = array(ChatIdentifierSchema).check(Schema.isMaxLength(chatPageSize));
/** A chat list watch's first page and the changed chats past it (`ChatListState`). */
export const ChatListStateSchema = struct({
  list: chatOutputSchemas.listChats,
  changed: rows,
  dropped: sequence,
});
/**
 * Page rows upserted and removed; `order` lists the page's conversation IDs after the change.
 * `changed` upserts changed chats past the page and lists their IDs after the change.
 */
export const ChatListDeltaSchema = struct({
  upsert: rows,
  remove: ids,
  order: ids,
  nextCursor: Schema.NullOr(cursor),
  changed: optional(struct({ upsert: rows, order: ids })),
  dropped: optional(sequence),
});
/** The provider setup fields that changed. */
export const ProviderSetupDeltaSchema = struct({
  providers: optional(ProviderStateSchema.fields.providers),
  flow: optional(ProviderStateSchema.fields.flow),
});
const subscriptionValueSchemas = {
  chat: ChatSnapshotSchema,
  chatList: ChatListStateSchema,
  providerSetup: ProviderStateSchema,
  workspace: WorkspaceWatchValueSchema,
};
const deltaSchemas = {
  chat: ChatDeltaSchema,
  chatList: ChatListDeltaSchema,
  providerSetup: ProviderSetupDeltaSchema,
  workspace: Schema.Never,
};

const seq = { seq: sequence };
const subscription = {
  ...seq,
  type: Schema.Literal('subscribe'),
  subscriptionId: SocketNonceSchema,
};
/** Resumes a subscription this ID held on an earlier connection, after the update it last applied. */
const afterSequence = { afterSequence: optional(sequence) };
/** What a client sends once authenticated; every message carries the connection's next `seq`. */
export const SocketClientMessageSchema = Schema.Union([
  struct({
    ...seq,
    type: Schema.Literal('hello'),
    protocol: Schema.Literal(chatProtocolVersion),
    host: ChatHostTargetSchema,
    nonce: SocketNonceSchema,
  }),
  struct({
    ...seq,
    type: Schema.Literal('request'),
    id: SocketRequestIdSchema,
    operation: bytes(64),
    input: Schema.Unknown,
  }),
  /**
   * One chunk of a workspace request whose JSON (`{operation, input}`) exceeds a frame. A
   * request's chunks are sent back to back; any other message between them is refused.
   */
  struct({
    ...seq,
    type: Schema.Literal('requestChunk'),
    id: SocketRequestIdSchema,
    offset: count(socketLimits.workspaceRequestBytes - 1),
    total: Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: socketLimits.workspaceRequestBytes }),
    ),
    data: SocketChunkDataSchema,
  }),
  struct({ ...seq, type: Schema.Literal('cancel'), id: SocketRequestIdSchema }),
  struct({
    ...subscription,
    kind: Schema.Literal('chat'),
    target: ChatTargetSchema,
    ...afterSequence,
  }),
  struct({
    ...subscription,
    kind: Schema.Literal('chatList'),
    target: ChatSessionSchema,
    ...afterSequence,
  }),
  struct({
    ...subscription,
    kind: Schema.Literal('providerSetup'),
    target: ProviderSetupTargetSchema,
    ...afterSequence,
  }),
  struct({
    ...subscription,
    kind: Schema.Literal('workspace'),
    target: WorkspaceWatchTargetSchema,
    ...afterSequence,
  }),
  struct({ ...seq, type: Schema.Literal('unsubscribe'), subscriptionId: SocketNonceSchema }),
  struct({ ...seq, type: Schema.Literal('heartbeat') }),
]);
/** A chunked request's reassembled JSON. */
export const SocketChunkedRequestSchema = struct({
  operation: bytes(64),
  input: Schema.Unknown,
});
/** The server's first message, before authentication and without a MAC. */
export const SocketChallengeSchema = struct({
  type: Schema.Literal('challenge'),
  protocol: Schema.Literal(chatProtocolVersion),
  challenge: SocketNonceSchema,
});
const chunkOf = (limit: number) => ({
  offset: count(limit - 1),
  total: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: limit })),
  data: SocketChunkDataSchema,
});
const chunk = chunkOf(socketLimits.payloadBytes);
const update = { ...seq, type: Schema.Literal('update'), subscriptionId: SocketNonceSchema };
/** What a server sends once the hello is accepted; every message carries its next `seq`. */
export const SocketServerMessageSchema = Schema.Union([
  struct({ ...seq, type: Schema.Literal('welcome'), health: ChatHostHealthSchema }),
  /**
   * One chunk of a reply's JSON (`SocketReplySchema`). A chat or daemon reply is at most
   * `payloadBytes`; a workspace reply at most `workspaceReplyBytes`, its chunks interleaved with
   * updates.
   */
  struct({
    ...seq,
    type: Schema.Literal('reply'),
    id: SocketRequestIdSchema,
    ...chunkOf(socketLimits.workspaceReplyBytes),
  }),
  /** One chunk of a fresh snapshot, which resets the subscription at `sequence`. */
  struct({ ...update, sequence, kind: Schema.Literal('snapshot'), ...chunk }),
  /** A delta from `base`, the update before, to `sequence`. */
  struct({
    ...update,
    sequence,
    kind: Schema.Literal('delta'),
    base: sequence,
    delta: Schema.Unknown,
  }),
  /** The subscription ended; the client may subscribe again. */
  struct({ ...update, kind: Schema.Literal('error'), code: Schema.Literals(chatReplyErrorCodes) }),
  struct({ ...seq, type: Schema.Literal('heartbeat') }),
]);
/** A reply's reassembled JSON. */
export const SocketReplySchema = Schema.Union([
  /** `value` is absent for an operation that returns nothing. */
  struct({ ok: Schema.Literal(true), value: Schema.optionalKey(Schema.Unknown) }),
  struct({
    ok: Schema.Literal(false),
    error: struct({
      code: Schema.Literals(chatReplyErrorCodes),
      message: bytes(512),
      reason: optional(bytes(64)),
    }),
  }),
]);
export type SocketReply = typeof SocketReplySchema.Type;

const strict = { onExcessProperty: 'error', reportInput: false } as const;
const clientMessage = Schema.decodeUnknownSync(SocketClientMessageSchema, strict);
const serverMessage = Schema.decodeUnknownSync(SocketServerMessageSchema, strict);
const challenge = Schema.decodeUnknownSync(SocketChallengeSchema, strict);
const reply = Schema.decodeUnknownSync(SocketReplySchema, strict);
const chunkedRequest = Schema.decodeUnknownSync(SocketChunkedRequestSchema, strict);
const values = Object.fromEntries(
  Object.entries(subscriptionValueSchemas).map(([kind, schema]) => [
    kind,
    Schema.decodeUnknownSync(schema, { onExcessProperty: 'ignore', reportInput: false }),
  ]),
) as Record<SocketSubscriptionKind, (value: unknown) => unknown>;
const deltas = Object.fromEntries(
  Object.entries(deltaSchemas).map(([kind, schema]) => [
    kind,
    Schema.decodeUnknownSync(schema, strict),
  ]),
) as Record<SocketSubscriptionKind, (value: unknown) => unknown>;

const decoding =
  <A>(decode: (value: unknown) => A, code: 'InvalidInput' | 'Incompatible') =>
  (value: unknown): A => {
    try {
      return decode(value);
    } catch {
      throw new ApplicationError({ code, message: 'Invalid socket message.' });
    }
  };
/** A server decodes what a client sends; anything else ends the connection. */
export const decodeSocketClientMessage = decoding(
  clientMessage as (value: unknown) => SocketClientMessage,
  'InvalidInput',
);
export const decodeSocketServerMessage = decoding(
  serverMessage as (value: unknown) => SocketServerMessage,
  'Incompatible',
);
export const decodeSocketChallenge = decoding(
  challenge as (value: unknown) => SocketChallenge,
  'Incompatible',
);
export const decodeSocketReply = decoding(reply, 'Incompatible');
/** A server decodes the JSON a client's request chunks reassemble to. */
export const decodeSocketChunkedRequest = decoding(chunkedRequest, 'InvalidInput');
export function decodeSocketDelta<K extends SocketSubscriptionKind>(
  kind: K,
  value: unknown,
): SocketDelta<K> {
  return decoding(deltas[kind], 'Incompatible')(value) as SocketDelta<K>;
}
export function decodeSocketSubscriptionValue<K extends SocketSubscriptionKind>(
  kind: K,
  value: unknown,
): SocketSubscriptionValue<K> {
  return decoding(values[kind], 'Incompatible')(value) as SocketSubscriptionValue<K>;
}
