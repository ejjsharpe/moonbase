import * as Schema from 'effect/Schema';
import { voidResult } from './schema.ts';
import { Rpc, RpcGroup } from 'effect/rpc';
import { ApplicationError } from './errors.ts';
import { ChatHostTargetSchema } from './host-schema.ts';
import {
  ChatSessionSchema,
  ChatSnapshotSchema,
  ChatTargetSchema,
  chatInputSchemas,
  chatOutputSchemas,
} from './chat-schema.ts';
import { ChatDeltaSchema, ChatListDeltaSchema, ChatListStateSchema } from './socket-schema.ts';
import { RpcAdmission } from './rpc-admission.ts';

/** What every chat procedure fails with on the wire. */
export const ChatRpcErrorSchema = ApplicationError;
/** One request: the host it is for, named at the top level, and the operation's input. */
const request = <S extends Schema.Top>(input: S) => ({ host: ChatHostTargetSchema, input });
/** A reply's schema on the wire: no reply is `Schema.Void`, which encodes as JSON. */
const wire = <S extends Schema.Top>(schema: S) =>
  (schema === (voidResult as unknown) ? Schema.Void : schema) as S;
const call = <const K extends keyof typeof chatInputSchemas>(operation: K) =>
  Rpc.make(operation, {
    payload: request(chatInputSchemas[operation]),
    success: wire(chatOutputSchemas[operation]),
    error: ChatRpcErrorSchema,
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
    error: ChatRpcErrorSchema,
    stream: true,
  }),
  Rpc.make('watchChatList', {
    payload: { host: ChatHostTargetSchema, session: ChatSessionSchema },
    success: ChatListUpdateSchema,
    error: ChatRpcErrorSchema,
    stream: true,
  }),
).middleware(RpcAdmission) {}
