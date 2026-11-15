import * as Schema from 'effect/Schema';
import {
  ApplicationError,
  type ApplicationErrorCode,
  type CancelledError,
} from '@moonbase/contracts/errors';
import { ipcLimits } from './ipc-limits.ts';

// What desktop IPC procedures fail with (D14). Main refuses with the errors below; the services it
// passes requests on to still fail with the legacy `ApplicationError`, which crosses with its
// message bounded. Each message is Moonbase's own. The renderer turns these into
// `ApplicationError`s, with the codes they have always had, where it hands them to the
// application (`toLegacyApplicationError`), until the application reads tags (CL-22).

const inputProblems = {
  'too-large': ['InvalidInput', 'Command input is too large.'],
  'string-too-long': ['InvalidInput', 'Input too large.'],
  'array-too-long': ['InvalidInput', 'Input array too large.'],
  'checkout-path': ['InvalidInput', 'Invalid checkout path.'],
  'request-id': ['InvalidInput', 'Invalid request identity.'],
  'chat-request': ['InvalidInput', 'Invalid chat request.'],
} as const satisfies Record<string, readonly [ApplicationErrorCode, string]>;
/** Main refuses the request's input as given. */
export class IpcInputError extends Schema.TaggedError<IpcInputError>()('IpcInputError', {
  problem: Schema.Literals(Object.keys(inputProblems) as [keyof typeof inputProblems]),
}) {
  override get message(): string {
    return inputProblems[this.problem][1];
  }
}

const authorityRefusals = {
  'foreign-client': ['Unauthorized', 'Foreign editor identity.'],
  checkout: ['Unauthorized', 'Choose this exact checkout with the native picker.'],
  root: ['Unauthorized', 'A renderer path is not native root approval.'],
  'worktree-location': [
    'Unauthorized',
    'A renderer path is not native worktree location approval.',
  ],
  'chat-target': ['Unauthorized', 'Choose an installed chat target.'],
  host: ['Unauthorized', 'Use the configured host and store.'],
  actor: ['Unauthorized', 'Use the configured actor.'],
} as const satisfies Record<string, readonly [ApplicationErrorCode, string]>;
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
  requests: ['InvalidInput', 'Too many active requests of this kind.'],
  watches: ['InvalidInput', 'Too many active requests of this kind.'],
  copies: ['Unavailable', 'Another Copy is in progress. Try again when it finishes.'],
} as const satisfies Record<string, readonly [ApplicationErrorCode, string]>;
/** The document already runs as many of these at once as main allows. */
export class IpcBusyError extends Schema.TaggedError<IpcBusyError>()('IpcBusyError', {
  limit: Schema.Literals(Object.keys(busyLimits) as [keyof typeof busyLimits]),
}) {
  override get message(): string {
    return busyLimits[this.limit][1];
  }
}

const unavailableFeatures = {
  'folder-picker': ['Unavailable', 'Folder selection is unavailable.'],
  'new-worktree': ['Unavailable', 'New worktrees are unavailable.'],
  'turn-into-project': ['Unavailable', 'Turning a chat into a project is unavailable.'],
  'chat-target': ['Unavailable', 'This chat target is unavailable.'],
} as const satisfies Record<string, readonly [ApplicationErrorCode, string]>;
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
    return unavailableFeatures[this.feature][1];
  }
}

const nativeActionFailures = {
  'reveal-other-host': ['InvalidInput', 'Only files on this Mac can be shown in Finder.'],
  'reveal-missing': ['InvalidInput', 'That file or folder no longer exists.'],
  'link-failed': ['Unavailable', 'Could not open the link in your browser. Try again.'],
} as const satisfies Record<string, readonly [ApplicationErrorCode, string]>;
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

/** A legacy error as it crosses IPC: its message is at most `ipcLimits.errorMessageLength`. */
export const IpcApplicationErrorSchema = ApplicationError.check(
  Schema.makeFilter((error) => error.message.length <= ipcLimits.errorMessageLength),
);
/** `error` with its message cut to what may cross IPC. */
export const boundApplicationError = (error: ApplicationError) =>
  error.message.length <= ipcLimits.errorMessageLength
    ? error
    : new ApplicationError({
        code: error.code,
        message: error.message.slice(0, ipcLimits.errorMessageLength),
        ...(error.target ? { target: error.target } : {}),
      });

/** Everything a desktop procedure may fail with; each procedure declares the part it uses. */
export type DesktopIpcError =
  | ApplicationError
  | IpcInputError
  | IpcAuthorityError
  | IpcBusyError
  | IpcUnavailableError
  | NativeActionError
  | CancelledError;

/** The `ApplicationError` a desktop IPC failure has always reached the application as. */
export function toLegacyApplicationError(error: DesktopIpcError): ApplicationError {
  const legacy = (code: ApplicationErrorCode) =>
    new ApplicationError({ code, message: error.message });
  switch (error._tag) {
    case 'IpcInputError':
      return legacy(inputProblems[error.problem][0]);
    case 'IpcAuthorityError':
      return legacy(authorityRefusals[error.refusal][0]);
    case 'IpcBusyError':
      return legacy(busyLimits[error.limit][0]);
    case 'IpcUnavailableError':
      return legacy(unavailableFeatures[error.feature][0]);
    case 'NativeActionError':
      return legacy(nativeActionFailures[error.failure][0]);
    case 'CancelledError':
      return legacy('Cancelled');
    default:
      return error;
  }
}
