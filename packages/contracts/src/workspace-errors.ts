import * as Schema from 'effect/Schema';
import type { ErrorGroup } from './error-groups.ts';
import { isWorkspaceHostError, type WorkspaceHostError } from './workspace-host-errors.ts';

// What the client-facing `WorkspaceService` fails with (epic #273 D14): the file host's errors,
// which it passes on, and the client recovery store's own. Each names what happened and builds
// its message from its fields.

const recoveryConflicts = {
  'operation-identity': 'Operation identity changed before recovery publication.',
  'save-identity': 'Save identity changed before recovery publication.',
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
  get group(): ErrorGroup {
    return 'conflict';
  }
  override get message() {
    return recoveryConflicts[this.conflict];
  }
}

const pendingPublications = {
  save: 'Admitted Save recovery publication pending; previous valid snapshot retained. ',
  'operation-acknowledgement':
    'Known operation recovery publication is pending. Preserve the prior valid snapshot before acknowledgement.',
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
  get group(): ErrorGroup {
    return 'storage';
  }
  override get message() {
    return pendingPublications[this.pending] + (this.detail ?? '');
  }
}

const recoveryProblems = {
  'save-group': 'A Save publication group belongs to one client.',
  'destination-drafts': 'Destination has recovery drafts. Preserve them before replacement.',
  'invalid-state': 'Invalid recovery state.',
  'unknown-buffer': 'No such buffer is open in this recovery.',
  'buffer-replaced':
    'A move replaced this clean buffer with the file moved onto it. Keep its text under a new path.',
  'buffer-target': 'Another buffer is already open for this file.',
  'draft-open': 'The buffer has unsaved changes. Save or discard them before closing it.',
} as const;
/** The request asks the recovery store for something it refuses as given. */
export class InvalidRecoveryRequestError extends Schema.TaggedError<InvalidRecoveryRequestError>()(
  'InvalidRecoveryRequestError',
  {
    problem: Schema.Literals(Object.keys(recoveryProblems) as (keyof typeof recoveryProblems)[]),
  },
) {
  get group(): ErrorGroup {
    return 'refusal';
  }
  override get message() {
    return recoveryProblems[this.problem];
  }
}
/** Another client's recovery cannot be read, so it may hold drafts where the request would write. */
export class UnreadableRecoveryError extends Schema.TaggedError<UnreadableRecoveryError>()(
  'UnreadableRecoveryError',
  { client: Schema.String },
) {
  get group(): ErrorGroup {
    return 'refusal';
  }
  override get message() {
    return `Recovery of ${this.client} is unreadable and may hold drafts at the destination.`;
  }
}
/** A client may acknowledge another's operation only in a checkout it has opened itself. */
export class ObserverAccessError extends Schema.TaggedError<ObserverAccessError>()(
  'ObserverAccessError',
  {},
) {
  get group(): ErrorGroup {
    return 'access';
  }
  override get message() {
    return 'Observer has not opened this exact checkout.';
  }
}
/** A save the host never received: its text is kept as a draft, to be saved as a new request. */
export class SaveNotSentError extends Schema.TaggedError<SaveNotSentError>()(
  'SaveNotSentError',
  {},
) {
  get group(): ErrorGroup {
    return 'unavailable';
  }
  override get message() {
    return 'The save never reached the host; its text was kept as a draft. Save it again as a new request.';
  }
}
/** The host's reply says something the request cannot have produced. */
export class UnexpectedHostReplyError extends Schema.TaggedError<UnexpectedHostReplyError>()(
  'UnexpectedHostReplyError',
  {},
) {
  get group(): ErrorGroup {
    return 'incompatible';
  }
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

/** The recovery store's own error classes. */
export const recoveryErrors = [
  RecoveryConflictError,
  RecoveryPublicationError,
  InvalidRecoveryRequestError,
  UnreadableRecoveryError,
  ObserverAccessError,
  SaveNotSentError,
  UnexpectedHostReplyError,
] as const;
const isRecoveryError = Schema.is(Schema.Union(recoveryErrors));

/** Whether `value` is one of the workspace's errors, the host's or the recovery store's. */
export const isWorkspaceError = (value: unknown): value is WorkspaceError =>
  isWorkspaceHostError(value) || isRecoveryError(value);
