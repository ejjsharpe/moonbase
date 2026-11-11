import { ApplicationError, type ApplicationErrorCode } from '@moonbase/contracts/errors';

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

/**
 * What the daemon reports about a failure, on stderr and in its log: its own messages, which are
 * written to be safe, or a generic message for the code of any other failure.
 */
export function describeFailure(error: unknown): { code: ApplicationErrorCode; message: string } {
  if (error instanceof DaemonFailure) return { code: error.code, message: error.message };
  const code = ApplicationError.is(error) ? error.code : 'Unavailable';
  return { code, message: generic[code] ?? 'The daemon is unavailable.' };
}
