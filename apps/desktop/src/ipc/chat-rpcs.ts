import * as Schema from 'effect/Schema';
import { Rpc, RpcGroup } from 'effect/rpc';
import { CancelledError } from '@moonbase/contracts/errors';
import { array, optional, struct, voidResult } from '@moonbase/contracts/schema';
import {
  ChatSessionSchema,
  ChatSnapshotSchema,
  ChatTargetSchema,
  ChatTranscriptSelectionSchema,
  ChatTranscriptSourceSchema,
  chatInputSchemas,
  chatOutputSchemas,
} from '@moonbase/contracts/chat-schema';
import { ChatListStateSchema } from '@moonbase/contracts/socket-schema';
import { ProviderStateSchema, providerInputSchemas } from '@moonbase/contracts/providers-schema';
import {
  ConnectionSnapshotSchema,
  connectionInputSchemas,
  connectionOutputSchemas,
} from '@moonbase/contracts/connection-schema';
import { IpcAdmission } from './ipc-admission.ts';
import {
  IpcApplicationErrorSchema,
  IpcAuthorityError,
  IpcBusyError,
  IpcInputError,
  IpcUnavailableError,
  NativeActionError,
} from './ipc-errors.ts';
import { exact, IpcRequestIdSchema, IpcTextSchema } from './ipc-limits.ts';

/** A chat target main installed: this Mac's daemon, or the configured remote host. */
export const ChatTargetIdSchema = Schema.Literals(['local', 'remote']);
export type ChatTargetId = typeof ChatTargetIdSchema.Type;
export const DesktopChatTargetSchema = struct({
  id: ChatTargetIdSchema,
  label: Schema.String,
  mode: ChatTargetIdSchema,
});
export type DesktopChatTarget = typeof DesktopChatTargetSchema.Type;
/** Stored images larger than this are never read or previewed. */
export const maximumTranscriptImageBytes = 4 * 1024 * 1024;
/** A Copy of a message, or of one part; `code` is the parser's start of a code block in it. */
export const TranscriptCopySchema = struct({
  source: ChatTranscriptSourceSchema,
  selection: optional(ChatTranscriptSelectionSchema),
  /** Parser-provided original UTF-16 start within the selected part; main revalidates the node. */
  code: optional(
    struct({ start: Schema.Number.check(Schema.makeFilter((n) => Number.isSafeInteger(n))) }),
  ),
}).check(
  Schema.makeFilter(
    ({ selection, code }) =>
      !code || (!!selection && code.start >= 0 && code.start < selection.bytes),
  ),
);
export type TranscriptCopy = typeof TranscriptCopySchema.Type;
/** Main binds an issued image URL to this exact backend, source and fixed selection. */
export const TranscriptImageSchema = struct({
  source: ChatTranscriptSourceSchema,
  selection: ChatTranscriptSelectionSchema,
  mimeType: Schema.Literals(['image/png', 'image/jpeg']),
});
export type TranscriptImage = typeof TranscriptImageSchema.Type;
/** An http(s) URL with a host and no credentials, spaces or control characters. */
export const isTranscriptLink = (value: string) => {
  if (
    value.length > 8192 ||
    [...value].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)
  )
    return false;
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password
    );
  } catch {
    return false;
  }
};

const errors = [
  IpcApplicationErrorSchema,
  IpcInputError,
  IpcAuthorityError,
  IpcUnavailableError,
  CancelledError,
] as const;
const error = Schema.Union(errors);
const backendField = { backendId: ChatTargetIdSchema };
const backend = exact(Schema.Struct(backendField));
/** A payload of exactly `fields`. */
const fields = <F extends Schema.Struct.Fields>(fields: F) => exact(Schema.Struct(fields));
const wire = <S extends Schema.Top>(schema: S) =>
  (schema === (voidResult as unknown) ? Schema.Void : schema) as S;
const chat = <const K extends keyof typeof chatInputSchemas>(operation: K) =>
  Rpc.make(operation, {
    payload: fields({ ...backendField, input: chatInputSchemas[operation] }),
    success: wire(chatOutputSchemas[operation]),
    error,
  });
const providers = <const K extends keyof typeof providerInputSchemas>(operation: K) =>
  Rpc.make(operation, {
    payload: fields({ ...backendField, input: providerInputSchemas[operation] }),
    success: ProviderStateSchema,
    error,
  });
const connection = <const K extends keyof typeof connectionInputSchemas>(operation: K) =>
  Rpc.make(operation, {
    payload: fields({ input: connectionInputSchemas[operation] }),
    success: wire(connectionOutputSchemas[operation]),
    error,
  });

/**
 * Chat on each installed target, its provider setup and the remote host's connection, and the
 * native actions a transcript and a new chat need.
 */
export class DesktopChatRpcs extends RpcGroup.make(
  Rpc.make('getChatTargets', { success: array(DesktopChatTargetSchema), error }),
  Rpc.make('getChatContext', { payload: backend, success: ChatSessionSchema, error }),
  /** The native picker; the daemon approves the chosen folder for local chat. */
  Rpc.make('chooseChatFolder', { success: Schema.NullOr(Schema.String), error }),
  /** Local chat's recent folders, newest first, or a remote host's approved roots and folders. */
  Rpc.make('listChatFolders', { payload: backend, success: array(Schema.String), error }),
  /** A new local chat's linked worktree; a repeat with the same `requestId` gets the first. */
  Rpc.make('createChatWorktree', {
    payload: fields({ root: IpcTextSchema, branch: IpcTextSchema, requestId: IpcRequestIdSchema }),
    success: Schema.String,
    error,
  }),
  /** Opens a local chat without a project's folder as a project where it is; its root. */
  Rpc.make('turnChatIntoProject', {
    payload: fields({ conversationId: Schema.String.check(Schema.isBetweenLength(1, 512)) }),
    success: Schema.String,
    error,
  }),
  chat('getChatHost'),
  chat('listChats'),
  chat('createChat'),
  chat('getChat'),
  chat('getChatHistory'),
  chat('getChatTranscriptContent'),
  chat('findChatTranscript'),
  chat('getChatHistoryAround'),
  chat('sendChat'),
  chat('getChatSend'),
  chat('stopChat'),
  chat('settleChat'),
  chat('findChatFiles'),
  Rpc.make('watchChat', {
    payload: fields({ ...backendField, target: ChatTargetSchema }),
    success: ChatSnapshotSchema,
    error,
    stream: true,
  }),
  Rpc.make('watchChatList', {
    payload: fields({ ...backendField, session: ChatSessionSchema }),
    success: struct({ ...ChatListStateSchema.fields, reset: Schema.Boolean }),
    error,
    stream: true,
  }),
  providers('getProviders'),
  providers('startProviderLogin'),
  providers('answerProviderPrompt'),
  providers('cancelProviderLogin'),
  providers('openProviderUrl'),
  providers('logoutProvider'),
  Rpc.make('watchProviders', {
    payload: backend,
    success: ProviderStateSchema,
    error,
    stream: true,
  }),
  connection('getConnection'),
  connection('connect'),
  connection('disconnect'),
  Rpc.make('watchConnection', { success: ConnectionSnapshotSchema, error, stream: true }),
  Rpc.make('copyTranscript', {
    payload: fields({ ...backendField, copy: TranscriptCopySchema }),
    error: Schema.Union([...errors, IpcBusyError]),
  }),
  Rpc.make('openTranscriptLink', {
    payload: fields({
      ...backendField,
      url: Schema.String.check(Schema.makeFilter(isTranscriptLink)),
    }),
    error: Schema.Union([...errors, NativeActionError]),
  }),
  Rpc.make('getTranscriptImageUrl', {
    payload: fields({ ...backendField, image: TranscriptImageSchema }),
    success: Schema.String,
    error,
  }),
).middleware(IpcAdmission) {}
