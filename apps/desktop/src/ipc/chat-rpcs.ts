import * as Schema from 'effect/Schema';
import { Rpc, RpcGroup } from 'effect/rpc';
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
import { ChatListStateSchema } from '@moonbase/contracts/watch-schema';
import { ProviderStateSchema, providerInputSchemas } from '@moonbase/contracts/providers-schema';
import {
  ConnectionSnapshotSchema,
  connectionInputSchemas,
  connectionOutputSchemas,
} from '@moonbase/contracts/connection-schema';
import { IpcAdmission } from './ipc-admission.ts';
import {
  IpcAuthorityError,
  IpcBusyError,
  IpcInputError,
  IpcUnavailableError,
  NativeActionError,
} from '@moonbase/contracts/ipc-errors';
import { LocalDaemonError } from '@moonbase/contracts/connection-errors';
import { TranscriptReadError } from '@moonbase/application/chat';
import {
  chatServiceErrors,
  connectionFailures,
  localHostServiceErrors,
  providerSetupServiceErrors,
  TranscriptNativeError,
  workspaceHostErrors,
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

// Each procedure's errors: what its handler refuses, and what the one service it calls fails with.
const union = <const E extends readonly Schema.Top[]>(errors: E) =>
  Schema.Union([...new Set(errors)] as unknown as E);
/** A target's procedure refuses one main never installed or can't reach, or another host's. */
const target = [IpcAuthorityError, IpcUnavailableError] as const;
const chatError = union([...target, ...chatServiceErrors]);
const providersError = union([...target, ...providerSetupServiceErrors]);
/** The remote connection: a target without one is refused as an invalid chat request. */
const connectionError = union([...target, IpcInputError, ...connectionFailures]);
/** A local chat's native action, refused while quitting, over this Mac's daemon. */
const localFolderError = union([IpcUnavailableError, ...localHostServiceErrors]);
const localWorkspaceError = union([IpcUnavailableError, ...workspaceHostErrors]);
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
    error: chatError,
  });
const providers = <const K extends keyof typeof providerInputSchemas>(operation: K) =>
  Rpc.make(operation, {
    payload: fields({ ...backendField, input: providerInputSchemas[operation] }),
    success: ProviderStateSchema,
    error: providersError,
  });
const connection = <const K extends keyof typeof connectionInputSchemas>(operation: K) =>
  Rpc.make(operation, {
    payload: fields({ input: connectionInputSchemas[operation] }),
    success: wire(connectionOutputSchemas[operation]),
    error: connectionError,
  });

/**
 * Chat on each installed target, its provider setup and the remote host's connection, and the
 * native actions a transcript and a new chat need.
 */
export class DesktopChatRpcs extends RpcGroup.make(
  Rpc.make('getChatTargets', { success: array(DesktopChatTargetSchema) }),
  Rpc.make('getChatContext', {
    payload: backend,
    success: ChatSessionSchema,
    error: union([IpcAuthorityError, LocalDaemonError]),
  }),
  /** The native picker; the daemon approves the chosen folder for local chat. */
  Rpc.make('chooseChatFolder', {
    success: Schema.NullOr(Schema.String),
    error: localFolderError,
  }),
  /** Local chat's recent folders, newest first, or a remote host's approved roots and folders. */
  Rpc.make('listChatFolders', {
    payload: backend,
    success: array(Schema.String),
    error: union([IpcAuthorityError, ...localHostServiceErrors]),
  }),
  /** A new local chat's linked worktree; a repeat with the same `requestId` gets the first. */
  Rpc.make('createChatWorktree', {
    payload: fields({ root: IpcTextSchema, branch: IpcTextSchema, requestId: IpcRequestIdSchema }),
    success: Schema.String,
    error: localWorkspaceError,
  }),
  /** Opens a local chat without a project's folder as a project where it is; its root. */
  Rpc.make('turnChatIntoProject', {
    payload: fields({ conversationId: Schema.String.check(Schema.isBetweenLength(1, 512)) }),
    success: Schema.String,
    error: localWorkspaceError,
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
    error: chatError,
    stream: true,
  }),
  Rpc.make('watchChatList', {
    payload: fields({ ...backendField, session: ChatSessionSchema }),
    success: struct({ ...ChatListStateSchema.fields, reset: Schema.Boolean }),
    error: chatError,
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
    error: providersError,
    stream: true,
  }),
  connection('getConnection'),
  connection('connect'),
  connection('disconnect'),
  Rpc.make('watchConnection', {
    success: ConnectionSnapshotSchema,
    error: connectionError,
    stream: true,
  }),
  Rpc.make('copyTranscript', {
    payload: fields({ ...backendField, copy: TranscriptCopySchema }),
    error: union([
      ...target,
      IpcInputError,
      IpcBusyError,
      ...chatServiceErrors,
      TranscriptReadError,
      TranscriptNativeError,
    ]),
  }),
  Rpc.make('openTranscriptLink', {
    payload: fields({
      ...backendField,
      url: Schema.String.check(Schema.makeFilter(isTranscriptLink)),
    }),
    error: union([...target, IpcInputError, NativeActionError]),
  }),
  Rpc.make('getTranscriptImageUrl', {
    payload: fields({ ...backendField, image: TranscriptImageSchema }),
    success: Schema.String,
    error: union(target),
  }),
).middleware(IpcAdmission) {}
