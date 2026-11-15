import { ApplicationError, type ApplicationErrorCode } from './errors.ts';
import { toConnectionApplicationError, type ConnectionFailure } from './connection-errors.ts';
import type {
  ChatServiceError,
  LocalHostServiceError,
  ProviderSetupServiceError,
} from './services.ts';

/** A chat, folder or provider setup service's error, as it reaches a client. */
export type DaemonServiceError =
  | ChatServiceError
  | LocalHostServiceError
  | ProviderSetupServiceError;

const codes: Record<
  Exclude<DaemonServiceError, ConnectionFailure>['_tag'] | 'CancelledError',
  ApplicationErrorCode
> = {
  InvalidChatRequestError: 'InvalidInput',
  ChatBusyError: 'Conflict',
  TranscriptChangedError: 'Conflict',
  ChatAccessError: 'Unauthorized',
  ChatStoreError: 'Persistence',
  ChatStoreMismatchError: 'Incompatible',
  ChatUnavailableError: 'Unavailable',
  FolderRefusedError: 'Unauthorized',
  FolderMissingError: 'InvalidInput',
  FoldersUnavailableError: 'Unavailable',
  ProviderSetupRefusedError: 'InvalidInput',
  ProviderSetupUnavailableError: 'Unavailable',
  CredentialKeyError: 'Unavailable',
  CredentialStoreError: 'Persistence',
  HostUnavailableError: 'Unavailable',
  IncompatibleHostError: 'Incompatible',
  RequestReusedError: 'InvalidInput',
  UnauthorizedError: 'Unauthorized',
  UncertainError: 'Uncertain',
  CancelledError: 'Cancelled',
};

const isConnectionFailure = (error: { _tag: string }): error is ConnectionFailure =>
  error._tag === 'ConnectionError' || error._tag === 'HostVerificationError';
/** Whether `value` is a chat, folder, provider setup or daemon link error. */
export const isDaemonServiceError = (value: unknown): value is DaemonServiceError => {
  const tag = value instanceof Error ? (value as { _tag?: unknown })._tag : undefined;
  return (
    typeof tag === 'string' &&
    (Object.hasOwn(codes, tag) || isConnectionFailure(value as { _tag: string }))
  );
};
/** The legacy code a chat, folder, provider setup or daemon link error has always had. */
export function getDaemonErrorCode(error: DaemonServiceError): ApplicationErrorCode {
  if (ApplicationError.is(error)) return error.code;
  if (isConnectionFailure(error)) return toConnectionApplicationError(error).code;
  return codes[error._tag];
}

// The shared outcomes name the operation they concern, as the RPC procedure names it; a user
// sees this fixed text instead.
const outcomeMessages = {
  UncertainError: 'The outcome is uncertain. Check it before retrying; do not send it again.',
  UnauthorizedError: 'This request is not authorized.',
} as const;

/**
 * Legacy (epic #273 D14): a chat, folder or provider setup error as the `ApplicationError` its
 * code has always been, with the error's own message, or fixed text for a shared outcome. Applied
 * where these services reach consumers still on `ApplicationError` (the application's chat and
 * provider setup clients, desktop main's folder calls and the daemon's chat folders), until the
 * chat UI reads tags (CL-22).
 */
export function toChatApplicationError(error: DaemonServiceError): ApplicationError {
  if (ApplicationError.is(error)) return error;
  if (isConnectionFailure(error)) return toConnectionApplicationError(error);
  return new ApplicationError({
    code: getDaemonErrorCode(error),
    message: outcomeMessages[error._tag as keyof typeof outcomeMessages] ?? error.message,
  });
}
