import * as Schema from 'effect/Schema';
import { struct, optional } from './schema.ts';
import { ChatIdentifierSchema, ChatHostTargetSchema } from './host-schema.ts';
export { ChatIdentifierSchema, ChatHostTargetSchema } from './host-schema.ts';
import { ApplicationError } from './errors.ts';
import {
  chatPageSize,
  maximumChatFindQueryBytes,
  chatFindPageSize,
  chatPreviewBytes,
  chatLiveTextBytes,
  chatContentChunkBytes,
  chatManifestPageSize,
  maximumChatInputBytes,
  maximumChatReplyBytes,
  maximumChatMentions,
  maximumChatFileQueryBytes,
  chatFileMatchLimit,
  findChatMentionStarts,
  isChatMentionPath,
  type ChatCommand,
  type ChatInput,
  type ChatOutput,
  type ChatMention,
} from './chat.ts';

// Unicode mode matches unpaired surrogates without rejecting valid pairs.
const unicode = Schema.String.check(Schema.makeFilter((value) => !/[\ud800-\udfff]/u.test(value)));
const text = (bytes: number) =>
  unicode.check(
    Schema.makeFilter(
      (value) =>
        !value.includes('\0') && !!value.trim() && new TextEncoder().encode(value).length <= bytes,
    ),
  );
export const ChatSessionSchema = struct({
  host: ChatHostTargetSchema,
  actorId: ChatIdentifierSchema,
});
export const ChatTargetSchema = struct({
  ...ChatSessionSchema.fields,
  conversationId: ChatIdentifierSchema,
});
export const ChatStopTargetSchema = struct({
  target: ChatTargetSchema,
  submissionId: ChatIdentifierSchema,
  taskId: Schema.NullOr(ChatIdentifierSchema),
});
export const ChatReasoningEffortSchema = Schema.Literals([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export const ChatModelPreferenceSchema = struct({
  model: struct({ provider: ChatIdentifierSchema, modelId: text(256) }),
  reasoningEffort: optional(ChatReasoningEffortSchema),
});
const relativePath = Schema.String.check(Schema.makeFilter(isChatMentionPath));
export const ChatMentionSchema = struct({ path: relativePath });
const mentions = Schema.mutable(Schema.Array(ChatMentionSchema)).check(
  Schema.isMaxLength(maximumChatMentions),
);
/** Each mention is distinct and spelled in the text as a whole token, so the text alone still names every file. */
export const areChatMentionsInText = (value: { text: string; mentions?: readonly ChatMention[] }) =>
  !value.mentions ||
  (new Set(value.mentions.map((mention) => mention.path)).size === value.mentions.length &&
    value.mentions.every((mention) => findChatMentionStarts(value.text, mention.path).length > 0));
export const ChatMessageSchema = struct({
  text: text(maximumChatInputBytes),
  mentions: optional(mentions),
}).check(Schema.makeFilter(areChatMentionsInText));
const fileQuery = unicode.check(
  Schema.makeFilter(
    (value) =>
      !value.includes('\0') && new TextEncoder().encode(value).length <= maximumChatFileQueryBytes,
  ),
);
export const ChatFileMatchSchema = struct({
  path: relativePath,
  positions: Schema.mutable(
    Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1024 }))),
  ).check(Schema.isMaxLength(1024)),
});
/** Without `cwd`, a local chat has no project: the host makes it a new, empty folder of its own. */
export const ChatCreationSettingsSchema = struct({
  cwd: optional(text(4096)),
  ...ChatModelPreferenceSchema.fields,
});
const remoteHostConfiguration = struct({
  ...ChatSessionSchema.fields,
  cwd: text(4096),
  model: text(512),
});
export const ChatHostConfigurationSchema = Schema.Union([
  remoteHostConfiguration,
  struct({ ...ChatSessionSchema.fields, mode: Schema.Literal('local') }),
]);
const timestamp = text(64).check(Schema.makeFilter((value) => Number.isFinite(Date.parse(value))));
/** A listed chat's latest run: whether it is running or how it last ended, and when. */
export const ChatActivitySchema = struct({
  state: Schema.Literals(['idle', 'running', 'stopped', 'failed']),
  at: timestamp,
});
export const ChatSummarySchema = struct({
  target: ChatTargetSchema,
  title: text(200),
  createdAt: timestamp,
  cwd: text(4096),
  /** The working folder is one the host made for this chat alone, not a project. */
  ownFolder: optional(Schema.Literal(true)),
  model: text(512),
  reasoningEffort: optional(ChatReasoningEffortSchema),
  /** Present in chat listings; a snapshot reports the open chat's state itself. */
  activity: optional(ChatActivitySchema),
  /** When you settled the chat (set it aside); sending to it unsettles it. */
  settledAt: optional(timestamp),
});
const preview = unicode.check(
  Schema.makeFilter((value) => new TextEncoder().encode(value).length <= chatPreviewBytes),
);
const cursor = text(1024);
const integer = Schema.Number.check(
  Schema.makeFilter((value) => Number.isSafeInteger(value) && value >= 0),
);
const digest = Schema.String.check(Schema.makeFilter((value) => /^[a-f0-9]{64}$/.test(value)));
export const ChatTranscriptSourceSchema = Schema.Union([
  struct({
    kind: Schema.Literal('entry'),
    target: ChatTargetSchema,
    entryId: ChatIdentifierSchema,
  }),
  struct({
    kind: Schema.Literal('live'),
    target: ChatTargetSchema,
    submissionId: ChatIdentifierSchema,
    taskId: ChatIdentifierSchema,
    attempt: integer,
    incarnation: digest,
  }),
]);
export const ChatFindQuerySchema = unicode.check(
  Schema.makeFilter(
    (value) =>
      value.length > 0 &&
      !value.includes('\0') &&
      new TextEncoder().encode(value).length <= maximumChatFindQueryBytes,
  ),
);
export const ChatTranscriptMatchSchema = struct({
  source: struct({
    kind: Schema.Literal('entry'),
    target: ChatTargetSchema,
    entryId: ChatIdentifierSchema,
  }),
  partId: ChatIdentifierSchema,
  start: integer,
  end: integer,
  snippet: struct({ start: integer, text: preview }),
}).check(
  Schema.makeFilter(
    (value) =>
      value.end > value.start &&
      value.snippet.start <= value.start &&
      value.end <= value.snippet.start + value.snippet.text.length &&
      !/[\ud800-\udfff]/u.test(value.snippet.text) &&
      !/[\ud800-\udfff]/u.test(value.snippet.text.slice(0, value.start - value.snippet.start)) &&
      !/[\ud800-\udfff]/u.test(value.snippet.text.slice(value.end - value.snippet.start)),
  ),
);
export const ChatTranscriptSelectionSchema = struct({
  partId: ChatIdentifierSchema,
  bytes: integer,
  revision: digest,
});
export const ChatTranscriptPartSchema = struct({
  ...ChatTranscriptSelectionSchema.fields,
  kind: Schema.Literals([
    'text',
    'thinking',
    'arguments',
    'executed-arguments',
    'result',
    'details',
    'patch',
    'diff',
    'image',
    'notice',
  ]),
  role: Schema.Literals(['user', 'assistant', 'tool', 'system']),
  availability: Schema.Literals(['available', 'redacted', 'unsupported', 'unavailable']),
  encoding: Schema.Literals(['utf8', 'base64']),
  text: preview,
  truncated: Schema.Boolean,
  toolName: optional(text(128)),
  callId: optional(preview),
  taskId: optional(ChatIdentifierSchema),
  parentTaskId: optional(ChatIdentifierSchema),
  call: optional(struct({ entryId: ChatIdentifierSchema, partId: ChatIdentifierSchema })),
  committed: optional(struct({ entryId: ChatIdentifierSchema, partId: ChatIdentifierSchema })),
  pairing: optional(Schema.Literals(['matched', 'unmatched', 'ambiguous'])),
  state: optional(
    Schema.Literals([
      'requested',
      'running',
      'completed',
      'failed',
      'interrupted',
      'missing-result',
    ]),
  ),
  mimeType: optional(text(128)),
  droppedBytes: optional(integer),
  droppedLines: optional(integer),
});
export const ChatTranscriptSchema = struct({
  source: ChatTranscriptSourceSchema,
  parts: Schema.mutable(Schema.Array(ChatTranscriptPartSchema)).check(
    Schema.isMaxLength(chatManifestPageSize),
  ),
  nextCursor: Schema.NullOr(cursor),
  thinking: Schema.Literals(['available', 'redacted', 'none']),
});
const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;
/**
 * A running response's transcript: a text part may carry its whole text (`truncated` false), and
 * its parts' text stays within `chatLiveTextBytes` in all.
 */
/** A running response's transcript part, whose text may be whole rather than a preview. */
export const ChatLiveTranscriptPartSchema = struct({
  ...ChatTranscriptPartSchema.fields,
  text: unicode,
});
export const ChatLiveTranscriptSchema = struct({
  ...ChatTranscriptSchema.fields,
  parts: Schema.mutable(Schema.Array(ChatLiveTranscriptPartSchema)).check(
    Schema.isMaxLength(chatManifestPageSize),
    Schema.makeFilter(
      (parts) => parts.reduce((sum, part) => sum + utf8Bytes(part.text), 0) <= chatLiveTextBytes,
    ),
  ),
});
export const ChatEntrySchema = struct({
  id: ChatIdentifierSchema,
  role: Schema.Literals(['user', 'assistant', 'tool', 'system']),
  text: preview,
  truncated: Schema.Boolean,
  toolName: optional(text(128)),
  isError: optional(Schema.Boolean),
  /** When the message was recorded; a record without a message timestamp omits it. */
  createdAt: optional(
    text(64).check(Schema.makeFilter((value) => Number.isFinite(Date.parse(value)))),
  ),
  transcript: ChatTranscriptSchema,
});
export const ChatHistoryPageSchema = struct({
  entries: Schema.mutable(Schema.Array(ChatEntrySchema)).check(Schema.isMaxLength(chatPageSize)),
  olderCursor: Schema.NullOr(cursor),
});
export const ChatRunSchema = struct({
  stop: ChatStopTargetSchema,
  state: Schema.Literals(['running', 'stopping', 'deferred']),
  text: preview,
  truncated: Schema.Boolean,
  /** Absent while the run's task is completing, when only its text preview shows. */
  transcript: optional(ChatLiveTranscriptSchema),
});
export const ChatSnapshotSchema = struct({
  ...ChatHistoryPageSchema.fields,
  conversation: ChatSummarySchema,
  run: Schema.NullOr(ChatRunSchema),
  state: Schema.Literals(['idle', 'running', 'stopped', 'failed', 'uncertain']),
  message: optional(text(512)),
  transcriptBoundary: Schema.NullOr(ChatIdentifierSchema),
  observationStatus: optional(Schema.Literals(['connected', 'reconnecting'])),
});
/** Error codes a chat stream may sign; a stream never carries a mutation's `Uncertain` outcome. */
const chatStreamErrorCodes = [
  'InvalidInput',
  'Unauthorized',
  'Incompatible',
  'Conflict',
  'Persistence',
  'Unavailable',
  'Cancelled',
] as const;
/** Error codes a chat host may sign in an RPC reply. */
export const chatReplyErrorCodes = [...chatStreamErrorCodes, 'Uncertain'] as const;
// Network-only envelopes; ordinary snapshots/IPC remain browser-safe replacements.
export const ChatStreamRequestSchema = struct({
  target: ChatTargetSchema,
  connectionId: ChatIdentifierSchema,
});
const streamIdentity = {
  ...ChatStreamRequestSchema.fields,
  streamId: unicode.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
  sequence: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
};
/** One chunk of a chunked payload: canonical base64 of 1 to `chatContentChunkBytes` bytes. */
export const ChatContentChunkDataSchema = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const decoded = atob(value);
      return (
        decoded.length > 0 && decoded.length <= chatContentChunkBytes && btoa(decoded) === value
      );
    } catch {
      return false;
    }
  }),
);
export const ChatStreamFrameSchema = Schema.Union([
  struct({
    ...streamIdentity,
    kind: Schema.Literal('snapshot'),
    offset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: maximumChatReplyBytes })),
    total: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maximumChatReplyBytes })),
    data: ChatContentChunkDataSchema,
  }),
  struct({ ...streamIdentity, kind: Schema.Literal('heartbeat') }),
  struct({
    ...streamIdentity,
    kind: Schema.Literal('error'),
    code: Schema.Literals(chatStreamErrorCodes),
  }),
]);
export const decodeChatStreamRequest = Schema.decodeUnknownSync(ChatStreamRequestSchema, {
  onExcessProperty: 'error',
  reportInput: false,
});
export const decodeChatStreamFrame = Schema.decodeUnknownSync(ChatStreamFrameSchema, {
  onExcessProperty: 'error',
  reportInput: false,
});
const receipt = { target: ChatTargetSchema, requestId: ChatIdentifierSchema };
export const ChatSendReceiptSchema = Schema.Union([
  struct({ ...receipt, admission: Schema.Literal('reserved'), submissionId: Schema.Null }),
  struct({ ...receipt, admission: Schema.Literal('admitted'), submissionId: ChatIdentifierSchema }),
]);

export const chatInputSchemas = {
  getChatHost: struct({ host: ChatHostTargetSchema }),
  listChats: struct({ session: ChatSessionSchema, cursor: optional(cursor) }),
  createChat: struct({
    session: ChatSessionSchema,
    requestId: ChatIdentifierSchema,
    title: text(200),
    settings: optional(ChatCreationSettingsSchema),
  }),
  getChat: struct({ target: ChatTargetSchema }),
  getChatHistory: struct({ target: ChatTargetSchema, cursor }),
  getChatTranscriptContent: struct({
    source: ChatTranscriptSourceSchema,
    selection: optional(ChatTranscriptSelectionSchema),
    cursor: optional(cursor),
  }),
  findChatTranscript: struct({
    target: ChatTargetSchema,
    query: ChatFindQuerySchema,
    cursor: optional(cursor),
  }),
  getChatHistoryAround: struct({
    target: ChatTargetSchema,
    entryId: ChatIdentifierSchema,
    cursor: optional(cursor),
  }),
  sendChat: struct({
    target: ChatTargetSchema,
    requestId: ChatIdentifierSchema,
    ...ChatMessageSchema.fields,
  }).check(Schema.makeFilter(areChatMentionsInText)),
  getChatSend: struct(receipt),
  stopChat: struct({ stop: ChatStopTargetSchema, requestId: ChatIdentifierSchema }),
  /** Settles or unsettles a chat; setting its current state again changes nothing. */
  settleChat: struct({ target: ChatTargetSchema, settled: Schema.Boolean }),
  /** Files in a chat's working folder: an existing chat's, or an approved folder for a new one. */
  findChatFiles: Schema.Union([
    struct({ target: ChatTargetSchema, query: fileQuery }),
    struct({ session: ChatSessionSchema, cwd: text(4096), query: fileQuery }),
  ]),
};
export const chatOutputSchemas = {
  getChatHost: ChatHostConfigurationSchema,
  listChats: struct({
    conversations: Schema.mutable(Schema.Array(ChatSummarySchema)).check(
      Schema.isMaxLength(chatPageSize),
    ),
    nextCursor: Schema.NullOr(cursor),
  }),
  createChat: struct({ requestId: ChatIdentifierSchema, conversation: ChatSummarySchema }),
  getChat: ChatSnapshotSchema,
  getChatHistory: ChatHistoryPageSchema,
  getChatTranscriptContent: Schema.Union([
    struct({
      kind: Schema.Literal('manifest'),
      cursor: Schema.NullOr(cursor),
      ...ChatTranscriptSchema.fields,
    }),
    struct({
      kind: Schema.Literal('content'),
      cursor: Schema.NullOr(cursor),
      source: ChatTranscriptSourceSchema,
      selection: ChatTranscriptSelectionSchema,
      offset: integer,
      nextCursor: Schema.NullOr(cursor),
      encoding: Schema.Literals(['utf8', 'base64']),
      data: unicode.check(
        Schema.makeFilter(
          (value) => new TextEncoder().encode(value).length <= 6 * chatContentChunkBytes,
        ),
      ),
    }).check(
      Schema.makeFilter((value) => {
        try {
          const bytes =
            value.encoding === 'utf8'
              ? new TextEncoder().encode(value.data).length
              : atob(value.data).length;
          if (value.encoding === 'base64' && btoa(atob(value.data)) !== value.data) return false;
          const end = value.offset + bytes;
          return (
            bytes <= chatContentChunkBytes &&
            end <= value.selection.bytes &&
            (value.nextCursor === null
              ? end === value.selection.bytes
              : bytes > 0 && end < value.selection.bytes && value.nextCursor !== value.cursor)
          );
        } catch {
          return false;
        }
      }),
    ),
  ]),
  findChatTranscript: struct({
    target: ChatTargetSchema,
    query: ChatFindQuerySchema,
    cursor: Schema.NullOr(cursor),
    startCursor: cursor,
    upperEntryId: Schema.NullOr(ChatIdentifierSchema),
    matches: Schema.mutable(Schema.Array(ChatTranscriptMatchSchema)).check(
      Schema.isMaxLength(chatFindPageSize),
    ),
    progress: struct({ entries: integer, bytes: integer }),
    nextCursor: Schema.NullOr(cursor),
  }).check(
    Schema.makeFilter(
      (value) =>
        value.nextCursor === null ||
        (value.nextCursor !== value.cursor &&
          (value.progress.entries > 0 || value.progress.bytes > 0 || value.matches.length > 0)),
    ),
  ),
  getChatHistoryAround: struct({
    ...ChatHistoryPageSchema.fields,
    target: ChatTargetSchema,
    entryId: ChatIdentifierSchema,
    cursor: Schema.NullOr(cursor),
    newerCursor: Schema.NullOr(cursor),
    upperEntryId: ChatIdentifierSchema,
  }),
  sendChat: ChatSendReceiptSchema,
  getChatSend: Schema.NullOr(ChatSendReceiptSchema),
  stopChat: struct({
    stop: ChatStopTargetSchema,
    requestId: ChatIdentifierSchema,
    outcome: Schema.Literals(['stopped', 'terminal', 'superseded', 'pending']),
  }),
  settleChat: ChatSummarySchema,
  findChatFiles: struct({
    query: fileQuery,
    matches: Schema.mutable(Schema.Array(ChatFileMatchSchema)).check(
      Schema.isMaxLength(chatFileMatchLimit),
    ),
    partial: Schema.Boolean,
  }),
} satisfies Record<keyof typeof chatInputSchemas, Schema.Constraint>;

const inputs = Object.fromEntries(
  Object.entries(chatInputSchemas).map(([name, schema]) => [
    name,
    Schema.decodeUnknownSync(schema, { onExcessProperty: 'error', reportInput: false }),
  ]),
);
const outputs = Object.fromEntries(
  Object.entries(chatOutputSchemas).map(([name, schema]) => [
    name,
    Schema.decodeUnknownSync(schema, { onExcessProperty: 'ignore', reportInput: false }),
  ]),
);
export const isChatCommand = (value: unknown): value is ChatCommand =>
  typeof value === 'string' && Object.hasOwn(chatInputSchemas, value);

export function decodeChatInput<K extends ChatCommand>(operation: K, value: unknown): ChatInput<K> {
  try {
    if (!isChatCommand(operation)) throw Error('Unknown command');
    return inputs[operation](value) as ChatInput<K>;
  } catch {
    throw new ApplicationError({ code: 'InvalidInput', message: 'Invalid chat input.' });
  }
}
export function decodeChatOutput<K extends ChatCommand>(
  operation: K,
  value: unknown,
): ChatOutput<K> {
  try {
    if (!isChatCommand(operation)) throw Error('Unknown command');
    return outputs[operation](value) as ChatOutput<K>;
  } catch {
    throw new ApplicationError({ code: 'Incompatible', message: 'Invalid chat reply.' });
  }
}
