import * as Schema from 'effect/Schema';
import type { ErrorGroup } from './error-groups.ts';

// What desktop IPC fails with (epic #273 D14): main's refusals of a window's requests, and the
// renderer's own when it can't send a request or read a reply. They live here, beside the errors
// main passes on, because the application reads them too. Each reason has what it means for the
// request (`error-groups`) and its message, which is Moonbase's own.

const inputProblems = {
  'too-large': ['refusal', 'Command input is too large.'],
  'string-too-long': ['refusal', 'Input too large.'],
  'array-too-long': ['refusal', 'Input array too large.'],
  'checkout-path': ['refusal', 'Invalid checkout path.'],
  'request-id': ['refusal', 'Invalid request identity.'],
  'chat-request': ['refusal', 'Invalid chat request.'],
  'workspace-request': ['refusal', 'Invalid workspace input.'],
  'desktop-request': ['refusal', 'Invalid desktop request.'],
} as const satisfies Record<string, readonly [ErrorGroup, string]>;
/** The request's input was refused as given, by main or by the renderer before sending it. */
export class IpcInputError extends Schema.TaggedError<IpcInputError>()('IpcInputError', {
  problem: Schema.Literals(Object.keys(inputProblems) as [keyof typeof inputProblems]),
}) {
  override get message(): string {
    return inputProblems[this.problem][1];
  }
}

const authorityRefusals = {
  'foreign-client': ['access', 'Foreign editor identity.'],
  checkout: ['access', 'Choose this exact checkout with the native picker.'],
  root: ['access', 'A renderer path is not native root approval.'],
  'worktree-location': ['access', 'A renderer path is not native worktree location approval.'],
  'chat-target': ['access', 'Choose an installed chat target.'],
  host: ['access', 'Use the configured host and store.'],
  actor: ['access', 'Use the configured actor.'],
} as const satisfies Record<string, readonly [ErrorGroup, string]>;
/** The window's document may not do this: it names something main never approved for it. */
export class IpcAuthorityError extends Schema.TaggedError<IpcAuthorityError>()(
  'IpcAuthorityError',
  { refusal: Schema.Literals(Object.keys(authorityRefusals) as [keyof typeof authorityRefusals]) },
) {
  override get message(): string {
    return authorityRefusals[this.refusal][1];
  }
}

const busyLimits = {
  requests: ['refusal', 'Too many active requests of this kind.'],
  watches: ['refusal', 'Too many active requests of this kind.'],
  copies: ['unavailable', 'Another Copy is in progress. Try again when it finishes.'],
} as const satisfies Record<string, readonly [ErrorGroup, string]>;
/** The document already runs as many of these at once as main allows. */
export class IpcBusyError extends Schema.TaggedError<IpcBusyError>()('IpcBusyError', {
  limit: Schema.Literals(Object.keys(busyLimits) as [keyof typeof busyLimits]),
}) {
  override get message(): string {
    return busyLimits[this.limit][1];
  }
}

const unavailableFeatures = {
  'folder-picker': 'Folder selection is unavailable.',
  'new-worktree': 'New worktrees are unavailable.',
  'turn-into-project': 'Turning a chat into a project is unavailable.',
  'chat-target': 'This chat target is unavailable.',
} as const;
/** The feature is unavailable for this chat target, or while Moonbase quits. */
export class IpcUnavailableError extends Schema.TaggedError<IpcUnavailableError>()(
  'IpcUnavailableError',
  {
    feature: Schema.Literals(
      Object.keys(unavailableFeatures) as [keyof typeof unavailableFeatures],
    ),
  },
) {
  override get message(): string {
    return unavailableFeatures[this.feature];
  }
}

const nativeActionFailures = {
  'reveal-other-host': ['refusal', 'Only files on this Mac can be shown in Finder.'],
  'reveal-missing': ['refusal', 'That file or folder no longer exists.'],
  'link-failed': ['unavailable', 'Could not open the link in your browser. Try again.'],
  'finder-files': ['refusal', 'Invalid Finder file list.'],
  'no-finder-files': ['refusal', 'Clipboard contains no Finder files.'],
} as const satisfies Record<string, readonly [ErrorGroup, string]>;
/** An action main takes in the OS for the renderer could not be taken. */
export class NativeActionError extends Schema.TaggedError<NativeActionError>()(
  'NativeActionError',
  {
    failure: Schema.Literals(
      Object.keys(nativeActionFailures) as [keyof typeof nativeActionFailures],
    ),
  },
) {
  override get message(): string {
    return nativeActionFailures[this.failure][1];
  }
}

const requestStoreFailures = {
  unreadable: 'Moonbase could not read its record of chat requests left unknown. Try again.',
  corrupt:
    'Moonbase’s record of chat requests left unknown is damaged, so it cannot tell whether this was already sent.',
  unwritable: 'Moonbase could not record this chat request before sending it. Try again.',
} as const;
/**
 * Main's own record of request IDs whose outcome is unknown could not be read or written, so it
 * sent nothing rather than send under a new ID what may already have run.
 */
export class RequestStoreError extends Schema.TaggedError<RequestStoreError>()(
  'RequestStoreError',
  {
    failure: Schema.Literals(
      Object.keys(requestStoreFailures) as [keyof typeof requestStoreFailures],
    ),
  },
) {
  override get message(): string {
    return requestStoreFailures[this.failure];
  }
}

/**
 * The renderer's connection to main closed. A request already `sent` may have run, so it is
 * uncertain; one that wasn't never ran.
 */
export class IpcClosedError extends Schema.TaggedError<IpcClosedError>()('IpcClosedError', {
  sent: Schema.Boolean,
}) {
  override get message(): string {
    return this.sent
      ? 'The connection to Moonbase closed after this was sent. Check its outcome.'
      : 'The connection to Moonbase closed.';
  }
}

/** Main's handler failed; what went wrong stays in main. */
export class IpcFailedError extends Schema.TaggedError<IpcFailedError>()('IpcFailedError', {}) {
  override get message(): string {
    return 'Application effect failed';
  }
}

/** Main's reply could not be read as the procedure's reply. */
export class IpcReplyError extends Schema.TaggedError<IpcReplyError>()('IpcReplyError', {}) {
  override get message(): string {
    return 'Invalid reply from Moonbase.';
  }
}

/** Every error desktop IPC itself fails with. */
export type IpcError =
  | IpcInputError
  | IpcAuthorityError
  | IpcBusyError
  | IpcUnavailableError
  | NativeActionError
  | RequestStoreError
  | IpcFailedError
  | IpcClosedError
  | IpcReplyError;

/** What a desktop IPC error means for its request, by its reason (see `error-groups`). */
export function getIpcErrorGroup(error: IpcError): ErrorGroup {
  switch (error._tag) {
    case 'IpcInputError':
      return inputProblems[error.problem][0];
    case 'IpcAuthorityError':
      return authorityRefusals[error.refusal][0];
    case 'IpcBusyError':
      return busyLimits[error.limit][0];
    case 'IpcUnavailableError':
    case 'IpcFailedError':
      return 'unavailable';
    case 'NativeActionError':
      return nativeActionFailures[error.failure][0];
    case 'RequestStoreError':
      return 'storage';
    case 'IpcClosedError':
      return error.sent ? 'uncertain' : 'unavailable';
    case 'IpcReplyError':
      return 'incompatible';
  }
}
