import type { ChatError } from './chat-errors.ts';
import {
  getConnectionErrorGroup,
  type ConnectionError,
  type HostVerificationError,
  type LocalDaemonError,
} from './connection-errors.ts';
import type { CancelledError, UncertainError, UnauthorizedError } from './errors.ts';
import type { FolderError, InvalidRootsError } from './folder-errors.ts';
import type { HostKeyExposedError, DaemonLinkError } from './host-errors.ts';
import { getIpcErrorGroup, type IpcError } from './ipc-errors.ts';
import type { ProviderSetupError } from './provider-errors.ts';
import type {
  ChatServiceError,
  LocalHostServiceError,
  ProviderSetupServiceError,
} from './services.ts';
import type { RecoveryError } from './workspace-errors.ts';
import type { RecordedRefusalError, WorkspaceHostError } from './workspace-host-errors.ts';

// What a failure means for the request that failed (epic #273 D14), for the few decisions that
// depend on that rather than on what failed: whether to forget a request the host refused, watch
// again after a host could not be reached, or keep a request whose outcome is unknown. Each group
// names its errors by tag, and a reason where one class covers several; a module with errors of
// its own answers for its reasons beside these.

/** What a failure means for its request. */
export type ErrorGroup =
  /** Refused as given, before it ran; sent again unchanged, it is refused again. */
  | 'refusal'
  /** The caller may not do this. */
  | 'access'
  /** It conflicts with the state it was made against. */
  | 'conflict'
  /** The host, its connection or a service could not answer now; trying again may succeed. */
  | 'unavailable'
  /** The host or its reply is not one this client can use. */
  | 'incompatible'
  /** A store could not be read or written. */
  | 'storage'
  /** It may have run: check its outcome, never send it again. */
  | 'uncertain'
  /** Its caller cancelled it. */
  | 'cancelled';

/** Every error contracts defines that a service, host or the workspace client fails with. */
type ContractsError =
  | ChatError
  | FolderError
  | ProviderSetupError
  | DaemonLinkError
  | WorkspaceHostError
  | RecoveryError
  | InvalidRootsError
  | HostKeyExposedError
  | UnauthorizedError
  | UncertainError
  | CancelledError
  | LocalDaemonError
  | IpcError;
type ReasonedError = ConnectionError | HostVerificationError | RecordedRefusalError | IpcError;
const ipcTags: ReadonlySet<string> = new Set<IpcError['_tag']>([
  'IpcInputError',
  'IpcAuthorityError',
  'IpcBusyError',
  'IpcUnavailableError',
  'NativeActionError',
  'IpcFailedError',
  'IpcClosedError',
  'IpcReplyError',
]);

const groups: Record<Exclude<ContractsError, ReasonedError>['_tag'], ErrorGroup> = {
  InvalidChatRequestError: 'refusal',
  FolderMissingError: 'refusal',
  ProviderSetupRefusedError: 'refusal',
  RequestReusedError: 'refusal',
  InvalidPathError: 'refusal',
  CheckoutChangedError: 'refusal',
  InvalidRequestError: 'refusal',
  InvalidBaseError: 'refusal',
  InvalidPatternError: 'refusal',
  InvalidRecoveryRequestError: 'refusal',
  UnreadableRecoveryError: 'refusal',
  InvalidRootsError: 'refusal',
  HostKeyExposedError: 'refusal',
  ChatAccessError: 'access',
  FolderRefusedError: 'access',
  CheckoutAccessError: 'access',
  ObserverAccessError: 'access',
  UnauthorizedError: 'access',
  ChatBusyError: 'conflict',
  TranscriptChangedError: 'conflict',
  WorkspaceConflictError: 'conflict',
  BranchTakenError: 'conflict',
  RecoveryConflictError: 'conflict',
  ChatUnavailableError: 'unavailable',
  FoldersUnavailableError: 'unavailable',
  ProviderSetupUnavailableError: 'unavailable',
  CredentialKeyError: 'unavailable',
  HostUnavailableError: 'unavailable',
  WorkspaceUnavailableError: 'unavailable',
  WorktreeGitError: 'unavailable',
  GitStatusFormatError: 'unavailable',
  SaveNotSentError: 'unavailable',
  ChatStoreMismatchError: 'incompatible',
  IncompatibleHostError: 'incompatible',
  WorkspaceUnsupportedError: 'incompatible',
  UnexpectedHostReplyError: 'incompatible',
  ChatStoreError: 'storage',
  CredentialStoreError: 'storage',
  WorkspaceStoreError: 'storage',
  RecoveryPublicationError: 'storage',
  UncertainError: 'uncertain',
  UnresolvedWorkError: 'uncertain',
  InterruptedRequestError: 'uncertain',
  IncompleteCleanupError: 'uncertain',
  CancelledError: 'cancelled',
  LocalDaemonError: 'unavailable',
};
const recordedRefusals = {
  invalid: 'refusal',
  unauthorized: 'access',
  conflict: 'conflict',
  incompatible: 'incompatible',
} as const satisfies Record<RecordedRefusalError['refusal'], ErrorGroup>;

const tagOf = (value: unknown) => {
  const tag = value instanceof Error ? (value as { _tag?: unknown })._tag : undefined;
  return typeof tag === 'string' ? tag : undefined;
};
/** The group of one of contracts' errors; none for anything else. */
export function getErrorGroup(value: unknown): ErrorGroup | undefined {
  const tag = tagOf(value);
  if (tag === undefined) return undefined;
  if (tag === 'ConnectionError' || tag === 'HostVerificationError')
    return getConnectionErrorGroup(value as ConnectionError | HostVerificationError);
  if (tag === 'RecordedRefusalError')
    return recordedRefusals[(value as RecordedRefusalError).refusal];
  if (ipcTags.has(tag)) return getIpcErrorGroup(value as IpcError);
  return Object.hasOwn(groups, tag) ? groups[tag as keyof typeof groups] : undefined;
}

/**
 * Whether `value` is an error contracts defines, whose message is built from fixed text and its
 * fields and so may be shown (D11); anything else, such as a defect, shows only fixed text.
 */
export const isKnownError = (value: unknown) => getErrorGroup(value) !== undefined;

/** Refused as given, before it ran: nothing to resolve, and sent again it is refused again. */
export const isRefusal = (error: unknown) => getErrorGroup(error) === 'refusal';
/** The caller may not do this: it never ran. */
export const isAccessRefusal = (error: unknown) => getErrorGroup(error) === 'access';
/** It conflicts with the state it was made against, such as a source that changed under a read. */
export const isConflict = (error: unknown) => getErrorGroup(error) === 'conflict';
/** The host, its connection or a service could not answer now: watching or reading again may succeed. */
export const isUnavailable = (error: unknown) => getErrorGroup(error) === 'unavailable';
/** The host or its reply is not one this client can use; only the host can say what it ran. */
export const isIncompatible = (error: unknown) => getErrorGroup(error) === 'incompatible';
/** A store could not be read or written. */
export const isStorageFailure = (error: unknown) => getErrorGroup(error) === 'storage';
/** It may have run: its caller checks the outcome and never sends it again. */
export const isUncertain = (error: unknown) => getErrorGroup(error) === 'uncertain';
/** Its caller cancelled it. */
export const isCancelled = (error: unknown) => getErrorGroup(error) === 'cancelled';

/** A chat, folder or provider setup service's error, or its daemon link's, as it reaches a client. */
export type DaemonServiceError =
  | ChatServiceError
  | LocalHostServiceError
  | ProviderSetupServiceError;
const daemonServiceTags: ReadonlySet<string> = new Set<DaemonServiceError['_tag']>([
  'InvalidChatRequestError',
  'ChatBusyError',
  'TranscriptChangedError',
  'ChatAccessError',
  'ChatStoreError',
  'ChatStoreMismatchError',
  'ChatUnavailableError',
  'FolderRefusedError',
  'FolderMissingError',
  'FoldersUnavailableError',
  'ProviderSetupRefusedError',
  'ProviderSetupUnavailableError',
  'CredentialKeyError',
  'CredentialStoreError',
  'HostUnavailableError',
  'IncompatibleHostError',
  'RequestReusedError',
  'UnauthorizedError',
  'UncertainError',
  'CancelledError',
  'ConnectionError',
  'HostVerificationError',
  'LocalDaemonError',
]);
/** Whether `value` is a chat, folder, provider setup or daemon link error. */
export const isDaemonServiceError = (value: unknown): value is DaemonServiceError => {
  const tag = tagOf(value);
  return tag !== undefined && daemonServiceTags.has(tag);
};
