import * as Schema from 'effect/Schema';
import { struct, optional } from './schema.ts';
import { ChatIdentifierSchema, ChatHostTargetSchema } from './host-schema.ts';
export { ChatIdentifierSchema, ChatHostTargetSchema } from './host-schema.ts';
import { ApplicationError } from './errors.ts';
import {
  chatPageSize,
  chatPreviewBytes,
  maximumChatInputBytes,
  type ChatCommand,
  type ChatInput,
  type ChatOutput,
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
export const ChatCreationSettingsSchema = struct({
  cwd: text(4096),
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
export const ChatSummarySchema = struct({
  target: ChatTargetSchema,
  title: text(200),
  createdAt: text(64).check(Schema.makeFilter((value) => Number.isFinite(Date.parse(value)))),
  cwd: text(4096),
  model: text(512),
  reasoningEffort: optional(ChatReasoningEffortSchema),
});
const preview = unicode.check(
  Schema.makeFilter((value) => new TextEncoder().encode(value).length <= chatPreviewBytes),
);
export const ChatEntrySchema = struct({
  id: ChatIdentifierSchema,
  role: Schema.Literals(['user', 'assistant', 'tool', 'system']),
  text: preview,
  truncated: Schema.Boolean,
  toolName: optional(text(128)),
  isError: optional(Schema.Boolean),
});
const cursor = text(1024);
export const ChatHistoryPageSchema = struct({
  entries: Schema.mutable(Schema.Array(ChatEntrySchema)).check(Schema.isMaxLength(chatPageSize)),
  olderCursor: Schema.NullOr(cursor),
});
export const ChatToolActivitySchema = struct({
  taskId: ChatIdentifierSchema,
  name: text(128),
  state: Schema.Literals(['running', 'completed', 'failed']),
  text: preview,
  truncated: Schema.Boolean,
});
export const ChatRunSchema = struct({
  stop: ChatStopTargetSchema,
  state: Schema.Literals(['running', 'stopping', 'deferred']),
  text: preview,
  truncated: Schema.Boolean,
  tools: Schema.mutable(Schema.Array(ChatToolActivitySchema)).check(Schema.isMaxLength(8)),
});
export const ChatSnapshotSchema = struct({
  ...ChatHistoryPageSchema.fields,
  conversation: ChatSummarySchema,
  run: Schema.NullOr(ChatRunSchema),
  state: Schema.Literals(['idle', 'running', 'stopped', 'failed', 'uncertain']),
  message: optional(text(512)),
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
  sendChat: struct({
    target: ChatTargetSchema,
    requestId: ChatIdentifierSchema,
    text: text(maximumChatInputBytes),
  }),
  getChatSend: struct(receipt),
  stopChat: struct({ stop: ChatStopTargetSchema, requestId: ChatIdentifierSchema }),
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
  sendChat: ChatSendReceiptSchema,
  getChatSend: Schema.NullOr(ChatSendReceiptSchema),
  stopChat: struct({
    stop: ChatStopTargetSchema,
    requestId: ChatIdentifierSchema,
    outcome: Schema.Literals(['stopped', 'terminal', 'superseded', 'pending']),
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
