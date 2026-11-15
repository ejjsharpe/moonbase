import * as Schema from 'effect/Schema';
import { voidResult } from './schema.ts';
import { Rpc, RpcGroup } from 'effect/rpc';
import {
  ChatAccessError,
  ChatStoreError,
  ChatUnavailableError,
  InvalidChatRequestError,
} from './chat-errors.ts';
import { UncertainError } from './errors.ts';
import { folderErrors } from './folder-errors.ts';
import { hostErrors, RequestReusedError } from './host-errors.ts';
import { providerSetupErrors } from './provider-errors.ts';
import type { DaemonCommand } from './daemon.ts';
import { ChatHostTargetSchema, ChatIdentifierSchema } from './host-schema.ts';
import {
  hostProviderInputSchemas,
  hostProviderOutputSchemas,
  localHostInputSchemas,
  localHostOutputSchemas,
} from './daemon-schema.ts';
import { ProviderStateSchema } from './providers-schema.ts';
import { ProviderSetupDeltaSchema } from './watch-schema.ts';
import { RpcAdmission } from './rpc-admission.ts';

// What each daemon procedure fails with on the wire, besides the host's own errors. A mutation
// may also find its request ID reused.
/** A folder read: the approvals' refusals and failures. */
export const folderReadErrors = [...hostErrors, ...folderErrors] as const;
/** Approving a folder. */
export const folderApprovalErrors = [...folderReadErrors, RequestReusedError] as const;
/** Asking the chat engine for active work, which reads each chat's record. */
export const activeWorkErrors = [
  ...hostErrors,
  InvalidChatRequestError,
  ChatAccessError,
  ChatStoreError,
] as const;
/** Marking a chat's folder as a project: also a quitting engine, or an unknown outcome. */
export const markProjectErrors = [
  ...activeWorkErrors,
  ChatUnavailableError,
  RequestReusedError,
  UncertainError,
] as const;
/** A provider setup read or watch: provider setup's refusals, failures and credentials. */
export const providerReadErrors = [...hostErrors, ...providerSetupErrors] as const;
/** A provider setup mutation. */
export const providerMutationErrors = [...providerReadErrors, RequestReusedError] as const;

const FolderReadErrorSchema = Schema.Union(folderReadErrors),
  FolderApprovalErrorSchema = Schema.Union(folderApprovalErrors),
  ProviderReadErrorSchema = Schema.Union(providerReadErrors),
  ProviderMutationErrorSchema = Schema.Union(providerMutationErrors);
/**
 * The error union each daemon operation, and the provider setup watch, declares; a union's
 * `members` are its error classes.
 */
export const daemonErrorSchemas = {
  approveFolder: FolderApprovalErrorSchema,
  listRecentFolders: FolderReadErrorSchema,
  checkChatFolder: FolderReadErrorSchema,
  checkApprovedFolder: FolderReadErrorSchema,
  listHostFolders: FolderReadErrorSchema,
  getActiveWork: Schema.Union(activeWorkErrors),
  markFolderAsProject: Schema.Union(markProjectErrors),
  getProviders: ProviderReadErrorSchema,
  startProviderLogin: ProviderMutationErrorSchema,
  answerProviderPrompt: ProviderMutationErrorSchema,
  cancelProviderLogin: ProviderMutationErrorSchema,
  openProviderUrl: ProviderReadErrorSchema,
  logoutProvider: ProviderMutationErrorSchema,
  releaseProviderOwner: ProviderReadErrorSchema,
  watchProviderSetup: ProviderReadErrorSchema,
} satisfies Record<DaemonCommand | 'watchProviderSetup', unknown>;
const request = <S extends Schema.Top>(input: S) => ({ host: ChatHostTargetSchema, input });
/** A reply's schema on the wire: no reply is `Schema.Void`, which encodes as JSON. */
const wire = <S extends Schema.Top>(schema: S) =>
  (schema === (voidResult as unknown) ? Schema.Void : schema) as S;
const localHost = <const K extends keyof typeof localHostInputSchemas>(operation: K) =>
  Rpc.make(operation, {
    payload: request(localHostInputSchemas[operation]),
    success: wire(localHostOutputSchemas[operation]),
    error: daemonErrorSchemas[operation],
  });
const providers = <const K extends keyof typeof hostProviderInputSchemas>(operation: K) =>
  Rpc.make(operation, {
    payload: request(hostProviderInputSchemas[operation]),
    success: wire(hostProviderOutputSchemas[operation]),
    error: daemonErrorSchemas[operation],
  });
export const ProviderSetupUpdateSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('snapshot'), value: ProviderStateSchema }),
  Schema.Struct({ kind: Schema.Literal('delta'), delta: ProviderSetupDeltaSchema }),
]);

/** A local-mode daemon's folder approvals and control (`daemon-local-v1`, `folders-v1`, `roots-v1`). */
export class LocalHostRpcs extends RpcGroup.make(
  localHost('approveFolder'),
  localHost('listRecentFolders'),
  localHost('checkChatFolder'),
  localHost('checkApprovedFolder'),
  localHost('getActiveWork'),
  localHost('markFolderAsProject'),
  localHost('listHostFolders'),
).middleware(RpcAdmission) {}

/** Provider setup on a daemon, scoped to owners a client names (`providers-v1`). */
export class ProviderSetupRpcs extends RpcGroup.make(
  providers('getProviders'),
  providers('startProviderLogin'),
  providers('answerProviderPrompt'),
  providers('cancelProviderLogin'),
  providers('openProviderUrl'),
  providers('logoutProvider'),
  providers('releaseProviderOwner'),
  Rpc.make('watchProviderSetup', {
    payload: { host: ChatHostTargetSchema, ownerId: ChatIdentifierSchema },
    success: ProviderSetupUpdateSchema,
    error: daemonErrorSchemas.watchProviderSetup,
    stream: true,
  }),
).middleware(RpcAdmission) {}
