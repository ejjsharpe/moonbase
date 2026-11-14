import * as Schema from 'effect/Schema';
import { ApplicationError, type ApplicationErrorCode } from './errors.ts';
import {
  getWireCode,
  isWorkspaceHostError,
  type WorkspaceHostError,
} from './workspace-host-errors.ts';

// What the client-facing `WorkspaceService` fails with (epic #273 D14): the file host's errors,
// which it passes on, and the client recovery store's own. Each names what happened and builds
// its message from its fields. Until the editor reads tags (CL-14) and the workspace moves to
// Effect RPC (CL-07), `toWireError` sends each as the `ApplicationError` code and text clients
// have always read.

const recoveryConflicts = {
  'operation-identity': 'Operation identity changed before recovery publication.',
  'save-identity': 'Save identity changed before recovery publication.',
  'recovery-changed': 'Recovery changed in another window. Reload before publishing.',
  'operation-not-sent':
    'The operation never reached the host and did not run. Repeat it as a new operation.',
} as const;
/** The recovery store no longer holds what the request was made against. */
export class RecoveryConflictError extends Schema.TaggedError<RecoveryConflictError>()(
  'RecoveryConflictError',
  {
    conflict: Schema.Literals(Object.keys(recoveryConflicts) as (keyof typeof recoveryConflicts)[]),
  },
) {
  override get message() {
    return recoveryConflicts[this.conflict];
  }
}

const pendingPublications = {
  save: 'Admitted Save recovery publication pending; previous valid snapshot retained. ',
  'operation-acknowledgement':
    'Known operation recovery publication is pending. Preserve the prior valid snapshot before acknowledgement.',
  'reconcile-first': 'Publish reconciled recovery before acknowledging this operation.',
  'uncertain-draft':
    'An uncertain operation still owns this recovery draft. Inspect/reconcile the original paths before discarding it.',
  'save-running':
    'A Save in the complete recovery group is still running. Retry recovery after it settles.',
  'baseline-missing':
    'The text a Save began from is no longer in the recovery; its text is kept. Inspect disk.',
} as const;
/**
 * The recovery could not take an outcome in yet; the earlier recovery is kept. `detail` is the
 * safe text of what failed, when there is one.
 */
export class RecoveryPublicationError extends Schema.TaggedError<RecoveryPublicationError>()(
  'RecoveryPublicationError',
  {
    pending: Schema.Literals(
      Object.keys(pendingPublications) as (keyof typeof pendingPublications)[],
    ),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message() {
    return pendingPublications[this.pending] + (this.detail ?? '');
  }
}

const recoveryProblems = {
  'save-group': 'A Save publication group belongs to one client.',
  'destination-drafts': 'Destination has recovery drafts. Preserve them before replacement.',
  'invalid-state': 'Invalid recovery state.',
  'publication-id': 'Recovery request ID already belongs to a different immutable publication.',
} as const;
/** The request asks the recovery store for something it refuses as given. */
export class InvalidRecoveryRequestError extends Schema.TaggedError<InvalidRecoveryRequestError>()(
  'InvalidRecoveryRequestError',
  {
    problem: Schema.Literals(Object.keys(recoveryProblems) as (keyof typeof recoveryProblems)[]),
  },
) {
  override get message() {
    return recoveryProblems[this.problem];
  }
}
/** Another client's recovery cannot be read, so it may hold drafts where the request would write. */
export class UnreadableRecoveryError extends Schema.TaggedError<UnreadableRecoveryError>()(
  'UnreadableRecoveryError',
  { client: Schema.String },
) {
  override get message() {
    return `Recovery of ${this.client} is unreadable and may hold drafts at the destination.`;
  }
}
/** A client may acknowledge another's operation only in a checkout it has opened itself. */
export class ObserverAccessError extends Schema.TaggedError<ObserverAccessError>()(
  'ObserverAccessError',
  {},
) {
  override get message() {
    return 'Observer has not opened this exact checkout.';
  }
}
/** A save the host never received: its text is kept as a draft, to be saved as a new request. */
export class SaveNotSentError extends Schema.TaggedError<SaveNotSentError>()(
  'SaveNotSentError',
  {},
) {
  override get message() {
    return 'The save never reached the host; its text was kept as a draft. Save it again as a new request.';
  }
}
/** The host's reply says something the request cannot have produced. */
export class UnexpectedHostReplyError extends Schema.TaggedError<UnexpectedHostReplyError>()(
  'UnexpectedHostReplyError',
  {},
) {
  override get message() {
    return 'The host reports a different text saved.';
  }
}

/** The recovery store's own errors. */
export type RecoveryError =
  | RecoveryConflictError
  | RecoveryPublicationError
  | InvalidRecoveryRequestError
  | UnreadableRecoveryError
  | ObserverAccessError
  | SaveNotSentError
  | UnexpectedHostReplyError;
/** Every way a `WorkspaceService` command fails: the host's errors and the recovery store's. */
export type WorkspaceError = WorkspaceHostError | RecoveryError;

const codes: Record<RecoveryError['_tag'], ApplicationErrorCode> = {
  RecoveryConflictError: 'Conflict',
  RecoveryPublicationError: 'Persistence',
  InvalidRecoveryRequestError: 'InvalidInput',
  UnreadableRecoveryError: 'InvalidInput',
  ObserverAccessError: 'Unauthorized',
  SaveNotSentError: 'Unavailable',
  UnexpectedHostReplyError: 'Incompatible',
};
const isRecoveryError = (value: unknown): value is RecoveryError => {
  const tag = value instanceof Error ? (value as { _tag?: unknown })._tag : undefined;
  return typeof tag === 'string' && Object.hasOwn(codes, tag);
};

/** Whether `value` is one of the workspace's errors, the host's or the recovery store's. */
export const isWorkspaceError = (value: unknown): value is WorkspaceError =>
  isWorkspaceHostError(value) || isRecoveryError(value);

/** The wire code a workspace error is sent with. */
export const getErrorCode = (error: WorkspaceError): ApplicationErrorCode =>
  isRecoveryError(error) ? codes[error._tag] : getWireCode(error);

/** The wire error a workspace error is sent as: the code and text clients have always seen. */
export function toWireError(error: WorkspaceError): ApplicationError {
  if (ApplicationError.is(error)) return error;
  return new ApplicationError({ code: getErrorCode(error), message: error.message });
}
