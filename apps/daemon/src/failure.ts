import { ApplicationError, type ApplicationErrorCode } from '@moonbase/contracts/errors';
import { isChatError } from '@moonbase/contracts/chat-errors';
import { toChatApplicationError } from '@moonbase/contracts/chat-legacy-errors';
import { InvalidRootsError, isFolderError } from '@moonbase/contracts/folder-errors';
import { HostKeyExposedError, HostUnavailableError } from '@moonbase/contracts/host-errors';
import { CredentialKeyError, isProviderSetupError } from '@moonbase/contracts/provider-errors';

/** A daemon failure whose message names no path, secret or file contents. */
export class DaemonFailure extends Error {
  constructor(
    readonly code: ApplicationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DaemonFailure';
  }
}

const generic: Partial<Record<ApplicationErrorCode, string>> = {
  InvalidInput: 'The daemon configuration is invalid.',
  Incompatible: 'The daemon store or runtime is incompatible.',
  Persistence: 'The daemon store is unavailable; preserve its data directory.',
  Unauthorized: 'The daemon is not authorized to use its data.',
};

/** Startup refusals whose messages tell the operator what to fix, and name no path or contents. */
const startupRefusals: Record<string, ApplicationErrorCode> = {
  InvalidRootsError: 'InvalidInput',
  HostKeyExposedError: 'InvalidInput',
  CredentialKeyError: 'Unavailable',
};

/**
 * What the daemon reports about a failure, on stderr and in its log: its own messages, which are
 * written to be safe, or a generic message for the code of any other failure.
 */
export function describeFailure(error: unknown): { code: ApplicationErrorCode; message: string } {
  if (error instanceof DaemonFailure) return { code: error.code, message: error.message };
  if (
    error instanceof InvalidRootsError ||
    error instanceof HostKeyExposedError ||
    error instanceof CredentialKeyError
  )
    return { code: startupRefusals[error._tag]!, message: error.message };
  let code: ApplicationErrorCode = 'Unavailable';
  if (ApplicationError.is(error)) code = error.code;
  else if (
    isChatError(error) ||
    isFolderError(error) ||
    isProviderSetupError(error) ||
    error instanceof HostUnavailableError
  )
    code = toChatApplicationError(error).code;
  return { code, message: generic[code] ?? 'The daemon is unavailable.' };
}
