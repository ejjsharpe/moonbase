import * as Schema from 'effect/Schema';
import {
  ApplicationError,
  type ApplicationErrorCode,
  type CancelledError,
  type UncertainError,
} from './errors.ts';

// What the workspace file host fails with (epic #273 D14). Each error names what happened with a
// `kind` (and the names it concerns), and builds its message from them. Until the workspace moves
// to Effect RPC (CL-07), `toWireError` sends each as the `ApplicationError` code and text its
// clients have always read.

const pathProblems = {
  'not-relative': 'Use an exact checkout-relative path without traversal, links or metadata.',
  alias: 'Use exact paths without mount or symbolic-link aliases.',
  spelling: 'Use the actual on-disk spelling without case or Unicode aliases.',
  unsupported: 'Unsupported filesystem object.',
  reserved: 'This location is reserved by the workspace host.',
  'destination-parent': 'Destination parent must be a directory.',
  'watch-not-folder': 'Watch directory paths, including parent directories of files.',
  'ignore-not-child': 'Ignore paths must be immediate directory children.',
  'root-not-absolute': 'Choose an absolute checkout root through the native picker.',
  'not-checkout-root': 'Choose the repository checkout root.',
  'root-spelling': 'Choose the actual checkout spelling without case or Unicode aliases.',
  'location-not-absolute': 'Choose an absolute worktree location without traversal.',
  'location-parent-missing': 'The worktree location parent folder does not exist.',
  'location-parent-not-folder': 'The worktree location parent must be a folder.',
} as const;
/** A path the request names that the host will not use as given. */
export class InvalidPathError extends Schema.TaggedError<InvalidPathError>()('InvalidPathError', {
  problem: Schema.Literals(Object.keys(pathProblems) as (keyof typeof pathProblems)[]),
}) {
  override get message() {
    return pathProblems[this.problem];
  }
}

const accessRefusals = {
  remote: 'Remote targets are not local filesystem authority.',
  'not-approved':
    'Exact checkout identity is not approved. Choose the checkout through the native picker.',
  'outside-policy': 'This folder is outside what this host may open.',
  replaced: 'Checkout directory replaced. Reopen its original directory.',
  'chat-folder-changed': 'The folder changed before it opened as a project. Inspect it.',
  'chat-folder-repository': 'The chat folder belongs to another repository. Inspect its .git.',
  'native-reference-unusable':
    'Native reference expired, used or belongs to another client/checkout.',
  'native-reference-owner': 'Native reference belongs to another client/checkout.',
} as const;
/** The checkout, folder or native reference is not this caller's to use. */
export class CheckoutAccessError extends Schema.TaggedError<CheckoutAccessError>()(
  'CheckoutAccessError',
  { refusal: Schema.Literals(Object.keys(accessRefusals) as (keyof typeof accessRefusals)[]) },
) {
  override get message() {
    return accessRefusals[this.refusal];
  }
}

const changes = {
  directory: 'Checkout directory changed. Restore its original identity.',
  'git-metadata': 'Invalid checkout Git metadata.',
  'git-metadata-identity': 'Checkout Git metadata identity changed. Restore the original repository.',
  'common-directory': 'Repository common directory identity changed.',
  'ignore-policy': 'Invalid repository ignore policy.',
  identity: 'Checkout or repository identity changed. Restore the original directory.',
  'worktree-location': 'The new worktree location changed. Inspect it.',
  'worktree-repository': 'The new worktree belongs to another repository. Inspect it.',
  'worktree-parent': 'The worktree location parent changed. Choose the location again.',
  'move-destination': 'Move destination identity changed after native success.',
  'watch-directory': 'Watch directory changed during subscription.',
  'not-initialized': 'Git did not initialize this folder. Inspect it.',
} as const;
/** What the host checked on disk is not what it expected: a checkout, repository or object changed. */
export class CheckoutChangedError extends Schema.TaggedError<CheckoutChangedError>()(
  'CheckoutChangedError',
  { change: Schema.Literals(Object.keys(changes) as (keyof typeof changes)[]) },
) {
  override get message() {
    return changes[this.change];
  }
}

const requestProblems = {
  'text-too-large': 'Text unavailable: binary or exceeds 2 MiB.',
  'text-not-utf8': 'Text unavailable: invalid UTF-8.',
  'text-not-string': 'Invalid text.',
  'text-not-unicode': 'Invalid Unicode text.',
  'text-not-creation': 'Text belongs only to file creation.',
  'native-references': 'Invalid native references.',
  sources: 'Invalid operation source selection.',
  'source-checkout': 'Source target belongs to another checkout.',
  'overlapping-sources': 'Overlapping sources are not one selection.',
  'batch-destination': 'Batch destination must be an existing folder.',
  'colliding-destinations': 'Selection has colliding destination names.',
  replacements: 'Invalid replacement selection.',
  'replacement-target': 'Replacement must name the exact captured destination.',
  'duplicate-replacement': 'A destination cannot have multiple replacements.',
  'replacement-contains-source': 'A replacement cannot contain or replace a selected source.',
  'import-inside-source': 'Choose a native import destination outside its source directory.',
  'import-replaces-source': 'A native import cannot replace itself or an ancestor of its source.',
  'destination-inside-source': 'Choose a destination outside the source.',
  'destination-overlaps-source': 'Destination overlaps another selected source.',
  'ignore-filtering': 'Ignore filtering requires ignore classification.',
  'not-git': 'This project is not a Git repository. Initialize Git first.',
  'already-git': 'This project is already a Git repository.',
  'save-pending': 'A save awaits recovery. Resolve it before initializing Git.',
  'operation-pending':
    'A file operation awaits recovery publication or inspection. Resolve it before initializing Git.',
  'branch-name': 'Invalid branch name.',
  'chat-branch-name': 'Choose a simple branch name for the worktree.',
  'watch-limit': 'Watch subscription limit reached.',
  'native-limit': 'Native import selection limit reached.',
  'checkout-limit':
    'Open checkout resource limit reached. Restart after preserving recovery to release retained checkout descriptors.',
  configuration: 'Invalid workspace configuration.',
  'data-directory': 'Choose an explicit absolute Moonbase workspace data directory.',
  'not-a-store': 'This is not a Moonbase workspace store. Existing data retained.',
  'store-host': 'Workspace store belongs to a different host.',
  'store-client': 'Workspace store belongs to a different client.',
} as const;
/** The request asks for something the host refuses as given. */
export class InvalidRequestError extends Schema.TaggedError<InvalidRequestError>()(
  'InvalidRequestError',
  { problem: Schema.Literals(Object.keys(requestProblems) as (keyof typeof requestProblems)[]) },
) {
  override get message() {
    return requestProblems[this.problem];
  }
}
/** A worktree base that names no commit. */
export class InvalidBaseError extends Schema.TaggedError<InvalidBaseError>()('InvalidBaseError', {
  base: Schema.String,
}) {
  override get message() {
    return `Base ${this.base} is not a commit.`;
  }
}
/** A search pattern ripgrep cannot compile, with its reason. */
export class InvalidPatternError extends Schema.TaggedError<InvalidPatternError>()(
  'InvalidPatternError',
  { reason: Schema.String },
) {
  override get message() {
    return 'Invalid regular expression: ' + this.reason;
  }
}

const conflicts = {
  'location-exists': 'The worktree location already exists.',
  'location-registered': 'Another worktree is registered at the worktree location.',
  'git-entry': 'This folder already has a .git entry. Reopen it to use its repository.',
  'source-changed': 'Source changed. Capture a fresh selection before continuing.',
  'replacement-changed': 'Replacement changed. Confirm a freshly captured destination.',
  'save-not-started': 'The save request was reported as not started and can no longer run.',
  'save-payload': 'Save request ID already belongs to a different payload or target.',
  'operation-not-started': 'The operation was reported as not started and can no longer run.',
  'operation-payload': 'Operation ID already belongs to another payload/client/checkout.',
  'request-payload': 'Request ID already belongs to a different payload.',
} as const;
/** What the request expected no longer holds, or its ID already names something else. */
export class WorkspaceConflictError extends Schema.TaggedError<WorkspaceConflictError>()(
  'WorkspaceConflictError',
  { conflict: Schema.Literals(Object.keys(conflicts) as (keyof typeof conflicts)[]) },
) {
  override get message() {
    return conflicts[this.conflict];
  }
}
/** A branch name that is taken: as a branch, or by branches inside it. */
export class BranchTakenError extends Schema.TaggedError<BranchTakenError>()('BranchTakenError', {
  branch: Schema.String,
  inside: Schema.Boolean,
}) {
  override get message() {
    return this.inside
      ? `Branches inside ${this.branch}/ already exist.`
      : `Branch ${this.branch} already exists.`;
  }
}

const unavailable = {
  closed: 'Workspace scope is closed.',
  failed: 'Application effect failed',
  ripgrep: 'Standalone ripgrep is unavailable. Supply the packaged ripgrepExecutable asset.',
  'git-tools': 'Git is unavailable. Install the Xcode command-line tools on this Mac.',
  'merge-stages': 'Index contains unresolved merge stages; no single index baseline is available.',
  'native-cleanup': 'Native reference cleanup failed.',
} as const;
/** The host cannot do the work now: it is closing, a tool it needs is missing, or it failed. */
export class WorkspaceUnavailableError extends Schema.TaggedError<WorkspaceUnavailableError>()(
  'WorkspaceUnavailableError',
  { cause: Schema.Literals(Object.keys(unavailable) as (keyof typeof unavailable)[]) },
) {
  override get message() {
    return unavailable[this.cause];
  }
}
/** Git refused to make a worktree; `detail` is what it said (its own output, or a fixed text). */
export class WorktreeGitError extends Schema.TaggedError<WorktreeGitError>()('WorktreeGitError', {
  detail: Schema.String,
}) {
  override get message() {
    return 'Git could not create the worktree. ' + this.detail;
  }
}
/** Git printed a status record the host cannot read. */
export class GitStatusFormatError extends Schema.TaggedError<GitStatusFormatError>()(
  'GitStatusFormatError',
  { record: Schema.String },
) {
  override get message() {
    return `Unrecognized Git status record: ${JSON.stringify(this.record)}`;
  }
}

const unsupported = {
  'native-imports': 'This host does not accept native imports.',
  'chat-projects': 'This host cannot turn a chat into a project.',
  runtime: 'The workspace file host requires macOS on exactly Bun 1.4.4.',
} as const;
/** This host does not offer the operation, or cannot run where it was started. */
export class WorkspaceUnsupportedError extends Schema.TaggedError<WorkspaceUnsupportedError>()(
  'WorkspaceUnsupportedError',
  { feature: Schema.Literals(Object.keys(unsupported) as (keyof typeof unsupported)[]) },
) {
  override get message() {
    return unsupported[this.feature];
  }
}

const storeFailures = {
  'invalid-data': 'Invalid workspace saved data. Original data retained; publication blocked.',
  publication: 'Workspace journal publication failed; retain drafts and retry. ',
  reservation: 'Workspace request reservation failed; no mutation admitted. ',
  failed: 'Application effect failed',
} as const;
/** The store could not be read or written. A failed write names the safe text of what failed. */
export class WorkspaceStoreError extends Schema.TaggedError<WorkspaceStoreError>()(
  'WorkspaceStoreError',
  {
    failure: Schema.Literals(Object.keys(storeFailures) as (keyof typeof storeFailures)[]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message() {
    return storeFailures[this.failure] + (this.detail ?? '');
  }
}

const unresolved = {
  'save-interrupted': 'Interrupted save retained its intent. Ask for its status; do not repeat it.',
  'save-unacknowledgeable': 'An unresolved save cannot be acknowledged away.',
  'operation-unacknowledgeable':
    'Uncertain operation evidence cannot be acknowledged away. Inspect the affected paths.',
  'awaits-recovery':
    'An operation awaits recovery publication or inspection. Query its status; do not repeat the mutation.',
} as const;
/** An earlier save or operation has no known outcome: its caller asks for it, never repeats it. */
export class UnresolvedWorkError extends Schema.TaggedError<UnresolvedWorkError>()(
  'UnresolvedWorkError',
  { state: Schema.Literals(Object.keys(unresolved) as (keyof typeof unresolved)[]) },
) {
  override get message() {
    return unresolved[this.state];
  }
}
/** An earlier request with this ID was interrupted: inspect the repository, do not repeat it. */
export class InterruptedRequestError extends Schema.TaggedError<InterruptedRequestError>()(
  'InterruptedRequestError',
  { operation: Schema.String },
) {
  override get message() {
    return `The earlier ${this.operation} was interrupted. Inspect the repository; do not repeat it.`;
  }
}
/**
 * A worktree creation stopped or failed and could not undo all it made: `remains` says what is
 * left, `inspect` what to look at and `failure` what went wrong first.
 */
export class IncompleteCleanupError extends Schema.TaggedError<IncompleteCleanupError>()(
  'IncompleteCleanupError',
  {
    remains: Schema.String,
    inspect: Schema.String,
    failure: Schema.optional(Schema.String),
  },
) {
  override get message() {
    return this.failure === undefined
      ? `Worktree creation stopped and cleanup is incomplete (${this.remains}). Inspect ${this.inspect}.`
      : `Worktree creation failed and cleanup is incomplete (${this.remains}). Inspect ${this.inspect}. ${this.failure}`;
  }
}
/** A recorded refusal of a request, replayed with its code and text for the same request ID. */
export class RecordedRefusalError extends Schema.TaggedError<RecordedRefusalError>()(
  'RecordedRefusalError',
  {
    code: Schema.Literals(['InvalidInput', 'Unauthorized', 'Conflict', 'Incompatible']),
    text: Schema.String,
  },
) {
  override get message() {
    return this.text;
  }
}

/**
 * Every way a file host operation fails. `ApplicationError` stays only while a remote host's
 * replies arrive as wire errors (`RemoteWorkspaceHostLive`); CL-07 removes it.
 */
export type WorkspaceHostError =
  | InvalidPathError
  | CheckoutAccessError
  | CheckoutChangedError
  | InvalidRequestError
  | InvalidBaseError
  | InvalidPatternError
  | WorkspaceConflictError
  | BranchTakenError
  | WorkspaceUnavailableError
  | WorktreeGitError
  | GitStatusFormatError
  | WorkspaceUnsupportedError
  | WorkspaceStoreError
  | UnresolvedWorkError
  | InterruptedRequestError
  | IncompleteCleanupError
  | RecordedRefusalError
  | UncertainError
  | CancelledError
  | ApplicationError;

const codes: Record<
  Exclude<WorkspaceHostError, ApplicationError | RecordedRefusalError>['_tag'],
  ApplicationErrorCode
> = {
  InvalidPathError: 'InvalidInput',
  CheckoutAccessError: 'Unauthorized',
  CheckoutChangedError: 'InvalidInput',
  InvalidRequestError: 'InvalidInput',
  InvalidBaseError: 'InvalidInput',
  InvalidPatternError: 'InvalidInput',
  WorkspaceConflictError: 'Conflict',
  BranchTakenError: 'Conflict',
  WorkspaceUnavailableError: 'Unavailable',
  WorktreeGitError: 'Unavailable',
  GitStatusFormatError: 'Unavailable',
  WorkspaceUnsupportedError: 'Incompatible',
  WorkspaceStoreError: 'Persistence',
  UnresolvedWorkError: 'Uncertain',
  InterruptedRequestError: 'Uncertain',
  IncompleteCleanupError: 'Uncertain',
  UncertainError: 'Uncertain',
  CancelledError: 'Cancelled',
};

/** Whether `value` is one of the file host's errors. */
export const isWorkspaceHostError = (value: unknown): value is WorkspaceHostError => {
  if (ApplicationError.is(value)) return true;
  const tag = value instanceof Error ? (value as { _tag?: unknown })._tag : undefined;
  return typeof tag === 'string' && (tag === 'RecordedRefusalError' || Object.hasOwn(codes, tag));
};

/** The wire code a file host error is sent with. */
export const getWireCode = (error: WorkspaceHostError): ApplicationErrorCode =>
  ApplicationError.is(error) || error._tag === 'RecordedRefusalError'
    ? error.code
    : codes[error._tag];

/** The wire error a file host error is sent as: the code and text clients have always seen. */
export function toWireError(error: WorkspaceHostError): ApplicationError {
  if (ApplicationError.is(error)) return error;
  return new ApplicationError({ code: getWireCode(error), message: error.message });
}

