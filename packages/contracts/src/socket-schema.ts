import * as Schema from 'effect/Schema';
import { array, optional, struct } from './schema.ts';
import { ApplicationError } from './errors.ts';
import { chatManifestPageSize, chatPageSize, chatPreviewBytes } from './chat.ts';
import { chatProtocolVersion } from './host.ts';
import {
  ChatContentChunkDataSchema,
  ChatIdentifierSchema,
  ChatHostTargetSchema,
  ChatLiveTranscriptPartSchema,
  ChatSessionSchema,
  ChatSnapshotSchema,
  ChatSummarySchema,
  ChatTargetSchema,
  chatOutputSchemas,
  chatReplyErrorCodes,
} from './chat-schema.ts';
import { ChatHostHealthSchema } from './host-schema.ts';
import { ProviderStateSchema } from './providers-schema.ts';
import { socketLimits } from './socket.ts';
import {
  WorkspaceWatchTargetSchema,
  WorkspaceWatchValueSchema,
  hostInputSchemas,
  hostOutputSchemas,
} from './workspace-host-schema.ts';
import type {
  SocketDelta,
  SocketSubscriptionKind,
  SocketSubscriptionValue,
  SocketClientMessage,
  SocketServerMessage,
  SocketChallenge,
} from './socket.ts';
export { ChatSessionSchema, ChatTargetSchema } from './chat-schema.ts';

const unicode = Schema.String.check(Schema.makeFilter((value) => !/[\ud800-\udfff]/u.test(value)));
const bytes = (limit: number) =>
  unicode.check(
    Schema.makeFilter(
      (value) => !value.includes('\0') && new TextEncoder().encode(value).length <= limit,
    ),
  );
const count = (maximum: number) => Schema.Int.check(Schema.isBetween({ minimum: 0, maximum }));
const sequence = count(Number.MAX_SAFE_INTEGER);
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
    data: ChatContentChunkDataSchema,
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
  data: ChatContentChunkDataSchema,
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

/** Every root schema of the protocol, for the JSON Schema export. */
export const socketJsonSchemaRoots = {
  SocketChallenge: SocketChallengeSchema,
  SocketClientMessage: SocketClientMessageSchema,
  SocketServerMessage: SocketServerMessageSchema,
  SocketReply: SocketReplySchema,
  ChatDelta: ChatDeltaSchema,
  ChatListDelta: ChatListDeltaSchema,
  ProviderSetupDelta: ProviderSetupDeltaSchema,
  ChatSnapshot: ChatSnapshotSchema,
  ChatListState: ChatListStateSchema,
  ProviderState: ProviderStateSchema,
  WorkspaceWatchValue: WorkspaceWatchValueSchema,
  SocketChunkedRequest: SocketChunkedRequestSchema,
  /** Each workspace operation's input and reply, keyed by operation name. */
  WorkspaceHostInputs: struct(hostInputSchemas),
  WorkspaceHostOutputs: struct(hostOutputSchemas),
};

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
