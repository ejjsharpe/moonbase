import * as Schema from 'effect/Schema';
import {
  ApplicationError,
  CancelledError,
  type ApplicationErrorCode,
  type UncertainError,
} from './errors.ts';

// What the workspace file host fails with (epic #273 D14). Each error names what happened, and
// its `reason` is the text Moonbase wrote for it, safe to show. Until the workspace moves to
// Effect RPC (CL-07), `toWireError` turns each into the `ApplicationError` its clients expect.

/** The request names a path, selection or value the host refuses as given. */
export class InvalidWorkspaceRequestError extends Schema.TaggedError<InvalidWorkspaceRequestError>()(
  'InvalidWorkspaceRequestError',
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}
/** The checkout or path is not one the host may use for this caller. */
export class WorkspaceAccessDeniedError extends Schema.TaggedError<WorkspaceAccessDeniedError>()(
  'WorkspaceAccessDeniedError',
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}
/** What the request expected no longer holds: a changed source, a taken name or request ID. */
export class WorkspaceConflictError extends Schema.TaggedError<WorkspaceConflictError>()(
  'WorkspaceConflictError',
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}
/** The host could not do the work now: Git or a helper failed, or the host is closing. */
export class WorkspaceUnavailableError extends Schema.TaggedError<WorkspaceUnavailableError>()(
  'WorkspaceUnavailableError',
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}
/** This host does not offer the operation, or cannot run where it was started. */
export class WorkspaceUnsupportedError extends Schema.TaggedError<WorkspaceUnsupportedError>()(
  'WorkspaceUnsupportedError',
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}
/** The host's store could not be read or written. */
export class WorkspaceStoreError extends Schema.TaggedError<WorkspaceStoreError>()(
  'WorkspaceStoreError',
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}
/**
 * An earlier save, operation or request has no known outcome, or a cleanup is incomplete: the
 * caller inspects what `reason` names and never repeats the work.
 */
export class UnresolvedWorkError extends Schema.TaggedError<UnresolvedWorkError>()(
  'UnresolvedWorkError',
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}

/**
 * Every way a file host operation fails. `ApplicationError` stays only while a remote host's
 * replies arrive as wire errors (`RemoteWorkspaceHostLive`); CL-07 removes it.
 */
export type WorkspaceHostError =
  | InvalidWorkspaceRequestError
  | WorkspaceAccessDeniedError
  | WorkspaceConflictError
  | WorkspaceUnavailableError
  | WorkspaceUnsupportedError
  | WorkspaceStoreError
  | UnresolvedWorkError
  | UncertainError
  | CancelledError
  | ApplicationError;

const codes: Record<Exclude<WorkspaceHostError, ApplicationError>['_tag'], ApplicationErrorCode> = {
  InvalidWorkspaceRequestError: 'InvalidInput',
  WorkspaceAccessDeniedError: 'Unauthorized',
  WorkspaceConflictError: 'Conflict',
  WorkspaceUnavailableError: 'Unavailable',
  WorkspaceUnsupportedError: 'Incompatible',
  WorkspaceStoreError: 'Persistence',
  UnresolvedWorkError: 'Uncertain',
  UncertainError: 'Uncertain',
  CancelledError: 'Cancelled',
};

/** Whether `value` is one of the file host's errors. */
export const isWorkspaceHostError = (value: unknown): value is WorkspaceHostError => {
  if (ApplicationError.is(value)) return true;
  const tag = value instanceof Error ? (value as { _tag?: unknown })._tag : undefined;
  return typeof tag === 'string' && Object.hasOwn(codes, tag);
};

/** The wire error a file host error is sent as: the code and text clients have always seen. */
export function toWireError(error: WorkspaceHostError): ApplicationError {
  if (ApplicationError.is(error)) return error;
  return new ApplicationError({ code: codes[error._tag], message: error.message });
}

/** The host error a recorded wire code and message replay as. */
export function fromWireError(code: ApplicationErrorCode, message: string): WorkspaceHostError {
  switch (code) {
    case 'InvalidInput':
      return new InvalidWorkspaceRequestError({ reason: message });
    case 'Unauthorized':
      return new WorkspaceAccessDeniedError({ reason: message });
    case 'Conflict':
      return new WorkspaceConflictError({ reason: message });
    case 'Incompatible':
      return new WorkspaceUnsupportedError({ reason: message });
    case 'Persistence':
      return new WorkspaceStoreError({ reason: message });
    case 'Uncertain':
      return new UnresolvedWorkError({ reason: message });
    case 'Cancelled':
      return new CancelledError({ operation: message });
    default:
      return new WorkspaceUnavailableError({ reason: message });
  }
}
