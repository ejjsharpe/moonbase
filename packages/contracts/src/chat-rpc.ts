import * as Schema from 'effect/Schema';
import { voidResult } from './schema.ts';
import { Rpc, RpcGroup, RpcSchema } from 'effect/rpc';
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
import { findMarkedProcedures, isMutationRpc, Mutation, StatusCall } from './rpc-annotations.ts';

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
/** One request: the host it is for, named at the top level, and the operation's input. */
const request = <S extends Schema.Top>(input: S) => ({ host: ChatHostTargetSchema, input });
/** A reply's schema on the wire: no reply is `Schema.Void`, which encodes as JSON. */
const wire = <S extends Schema.Top>(schema: S) =>
  (schema === (voidResult as unknown) ? Schema.Void : schema) as S;
const procedure = <const K extends ChatCommand, E extends Schema.Top>(operation: K, error: E) =>
  Rpc.make(operation, {
    payload: request(chatInputSchemas[operation]),
    success: wire(chatOutputSchemas[operation]),
    error,
  });
const read = <const K extends ChatCommand>(operation: K) =>
  procedure(operation, ChatReadErrorSchema);
/** A command that changes chat state: a lost reply is `Uncertain`, and Quit waits for it. */
const mutation = <const K extends ChatCommand>(operation: K) =>
  procedure(operation, ChatMutationErrorSchema).annotate(Mutation, true);
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
  read('getChatHost'),
  read('listChats'),
  mutation('createChat'),
  read('getChat'),
  read('getChatHistory'),
  read('getChatTranscriptContent'),
  read('findChatTranscript'),
  read('getChatHistoryAround'),
  mutation('sendChat'),
  /** Resolves an `Uncertain` Send by its request ID, which may name another request. */
  procedure('getChatSend', ChatSendLookupErrorSchema).annotate(StatusCall, true),
  mutation('stopChat'),
  mutation('settleChat'),
  /** A file search, which also refuses a folder chats may not use. */
  procedure('findChatFiles', ChatFileSearchErrorSchema),
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

const chatMutations = findMarkedProcedures(ChatRpcs, isMutationRpc);
/** Commands that change chat state: a lost reply is `Uncertain`, and Quit waits for them. */
export const isChatMutation = (operation: ChatCommand) => chatMutations.has(operation);
/**
 * The error union a chat operation or watch declares; its `members` are the error classes. A
 * watch declares its union on the stream it succeeds with, so its own `errorSchema` is `Never`.
 */
export const chatErrorSchemaOf = (operation: ChatCommand | 'watchChat' | 'watchChatList') => {
  const rpc = ChatRpcs.requests.get(operation)!;
  return (
    RpcSchema.isStreamSchema(rpc.successSchema) ? rpc.successSchema.error : rpc.errorSchema
  ) as
    | typeof ChatReadErrorSchema
    | typeof ChatFileSearchErrorSchema
    | typeof ChatSendLookupErrorSchema
    | typeof ChatMutationErrorSchema;
};
