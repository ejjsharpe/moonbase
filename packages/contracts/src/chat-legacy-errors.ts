import { ApplicationError, type ApplicationErrorCode } from './errors.ts';
import { toConnectionApplicationError, type ConnectionFailure } from './connection-errors.ts';
import type {
  ChatServiceError,
  LocalHostServiceError,
  ProviderSetupServiceError,
} from './services.ts';

/** A chat, folder or provider setup service's error, as it reaches a client. */
type DaemonServiceError = ChatServiceError | LocalHostServiceError | ProviderSetupServiceError;

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

/**
 * Legacy (epic #273 D14): a chat, folder or provider setup error as the `ApplicationError` its
 * code has always been, with the error's own message. Applied once, where these services reach
 * consumers still on `ApplicationError` (the application's chat and provider setup clients, and
 * desktop main's folder calls), until the chat UI reads tags (CL-22).
 */
export function toChatApplicationError(error: DaemonServiceError): ApplicationError {
  if (ApplicationError.is(error)) return error;
  if (error._tag === 'ConnectionError' || error._tag === 'HostVerificationError')
    return toConnectionApplicationError(error);
  return new ApplicationError({ code: codes[error._tag], message: error.message });
}
