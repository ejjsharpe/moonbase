import * as Schema from 'effect/Schema';
import { voidResult } from './schema.ts';
import { Rpc, RpcGroup } from 'effect/rpc';
import {
  ChatAccessError,
  ChatBusyError,
  ChatStoreError,
  ChatStoreMismatchError,
  ChatUnavailableError,
  InvalidChatRequestError,
  TranscriptChangedError,
} from './chat-errors.ts';
import { UncertainError } from './errors.ts';
import { FolderRefusedError } from './folder-errors.ts';
import { hostErrors, RequestReusedError } from './host-errors.ts';
import { isChatMutation } from './chat-validation.ts';
import type { ChatCommand } from './chat.ts';
import { ChatHostTargetSchema } from './host-schema.ts';
import {
  ChatSessionSchema,
  ChatSnapshotSchema,
  ChatTargetSchema,
  chatInputSchemas,
  chatOutputSchemas,
} from './chat-schema.ts';
import { ChatDeltaSchema, ChatListDeltaSchema, ChatListStateSchema } from './watch-schema.ts';
import { RpcAdmission } from './rpc-admission.ts';

// What each chat procedure fails with on the wire, besides the host's own errors.
const store = [ChatAccessError, ChatStoreError, ChatStoreMismatchError, ChatUnavailableError];
/** A read or watch: a request it refuses, a transcript that changed under it, the store. */
export const chatReadErrors = [
  ...hostErrors,
  ...store,
  InvalidChatRequestError,
  TranscriptChangedError,
] as const;
/** Looking a Send up by its request ID, which may name another request. */
export const chatSendLookupErrors = [...chatReadErrors, RequestReusedError] as const;
/** A file search, which also refuses a folder chats may not use. */
export const chatFileSearchErrors = [...chatReadErrors, FolderRefusedError] as const;
/** A mutation: also a busy conversation, a refused folder, a reused request ID or an unknown outcome. */
export const chatMutationErrors = [
  ...hostErrors,
  ...store,
  InvalidChatRequestError,
  ChatBusyError,
  FolderRefusedError,
  RequestReusedError,
  UncertainError,
] as const;
const ChatReadErrorSchema = Schema.Union(chatReadErrors),
  ChatFileSearchErrorSchema = Schema.Union(chatFileSearchErrors),
  ChatSendLookupErrorSchema = Schema.Union(chatSendLookupErrors),
  ChatMutationErrorSchema = Schema.Union(chatMutationErrors);
/** The error union a chat operation or watch declares; its `members` are the error classes. */
export function chatErrorSchemaOf(operation: ChatCommand | 'watchChat' | 'watchChatList') {
  if (operation === 'watchChat' || operation === 'watchChatList') return ChatReadErrorSchema;
  if (isChatMutation(operation)) return ChatMutationErrorSchema;
  if (operation === 'findChatFiles') return ChatFileSearchErrorSchema;
  if (operation === 'getChatSend') return ChatSendLookupErrorSchema;
  return ChatReadErrorSchema;
}
/** One request: the host it is for, named at the top level, and the operation's input. */
const request = <S extends Schema.Top>(input: S) => ({ host: ChatHostTargetSchema, input });
/** A reply's schema on the wire: no reply is `Schema.Void`, which encodes as JSON. */
const wire = <S extends Schema.Top>(schema: S) =>
  (schema === (voidResult as unknown) ? Schema.Void : schema) as S;
const call = <const K extends keyof typeof chatInputSchemas>(operation: K) =>
  Rpc.make(operation, {
    payload: request(chatInputSchemas[operation]),
    success: wire(chatOutputSchemas[operation]),
    error: chatErrorSchemaOf(operation),
  });
/** A watch's first value, then deltas from it where one pays, else whole values again. */
const update = <V extends Schema.Top, D extends Schema.Top>(value: V, delta: D) =>
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal('snapshot'), value }),
    Schema.Struct({ kind: Schema.Literal('delta'), delta }),
  ]);
export const ChatUpdateSchema = update(ChatSnapshotSchema, ChatDeltaSchema);
export const ChatListUpdateSchema = update(ChatListStateSchema, ChatListDeltaSchema);

/** A chat host's operations and watches. */
export class ChatRpcs extends RpcGroup.make(
  call('getChatHost'),
  call('listChats'),
  call('createChat'),
  call('getChat'),
  call('getChatHistory'),
  call('getChatTranscriptContent'),
  call('findChatTranscript'),
  call('getChatHistoryAround'),
  call('sendChat'),
  call('getChatSend'),
  call('stopChat'),
  call('settleChat'),
  call('findChatFiles'),
  Rpc.make('watchChat', {
    payload: { host: ChatHostTargetSchema, target: ChatTargetSchema },
    success: ChatUpdateSchema,
    error: ChatReadErrorSchema,
    stream: true,
  }),
  Rpc.make('watchChatList', {
    payload: { host: ChatHostTargetSchema, session: ChatSessionSchema },
    success: ChatListUpdateSchema,
    error: ChatReadErrorSchema,
    stream: true,
  }),
).middleware(RpcAdmission) {}
