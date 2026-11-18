import * as Schema from 'effect/Schema';
import { chatProjectErrors } from '@moonbase/contracts/workspace-rpc';
import { chatErrors } from '@moonbase/contracts/chat-errors';
import { folderErrors } from '@moonbase/contracts/folder-errors';
import { providerSetupErrors } from '@moonbase/contracts/provider-errors';
import { hostErrors, RequestReusedError } from '@moonbase/contracts/host-errors';
import {
  ConnectionError,
  HostVerificationError,
  LocalDaemonError,
} from '@moonbase/contracts/connection-errors';
import { CancelledError, UncertainError } from '@moonbase/contracts/errors';
import { recoveryErrors } from '@moonbase/contracts/workspace-errors';
import {
  IpcAuthorityError,
  IpcFailedError,
  IpcInputError,
  IpcUnavailableError,
} from '@moonbase/contracts/ipc-errors';
import { ipcLimits } from './ipc-limits.ts';

// What desktop IPC procedures fail with (D14): main's refusals (contracts' `ipc-errors`, which the
// application reads too) and the errors of the services main passes requests on to, which cross as
// their tags and fields. Each procedure declares the unions below that it can fail with.

const unique = <A>(errors: readonly A[]) => [...new Set(errors)];
/** What main refuses any request with, and a handler that failed. */
export const ipcErrors = [
  IpcInputError,
  IpcAuthorityError,
  IpcUnavailableError,
  IpcFailedError,
  CancelledError,
] as const;
/** A service reached over a daemon link, besides its own errors: the link's and the host's. */
const linkErrors = [
  ...hostErrors,
  ConnectionError,
  HostVerificationError,
  LocalDaemonError,
  RequestReusedError,
  UncertainError,
  CancelledError,
] as const;
/** Chat, provider setup and folder requests to a chat target's daemon. */
export const chatTargetErrors = unique([
  ...ipcErrors,
  ...linkErrors,
  ...chatErrors,
  ...folderErrors,
  ...providerSetupErrors,
]);
/** The remote host's connection. */
export const connectionErrors = unique([
  ...ipcErrors,
  ConnectionError,
  HostVerificationError,
  LocalDaemonError,
]);
/** The editor's workspace: the file host's and the recovery store's, and a new chat's worktree. */
export const workspaceErrors = unique([
  ...ipcErrors,
  ...linkErrors,
  ...chatProjectErrors,
  ...chatErrors,
  ...recoveryErrors,
]);

const transcriptProblems = {
  'source-changed': 'Transcript source changed. Reload the content and try Copy again.',
  'code-changed':
    'The displayed code block changed as more Markdown was loaded. Read more and try Copy again.',
  'code-too-large': 'Code Copy supports parts up to 1 MiB. Copy the whole message instead.',
  'text-too-large': 'Copy supports up to 8 MiB of text. This content is larger.',
  'image-too-large': 'Stored image exceeds the 4 MiB preview limit.',
  binary: 'This part is binary and cannot be copied as text.',
  'not-image': 'This part is text, not stored image data.',
  'repeated-part': 'Transcript manifest repeats a selected part.',
  'no-text': 'No authored text is available to copy.',
  clipboard: 'Could not write to the clipboard. Try Copy again.',
  'images-busy': 'Image reads are busy.',
  'image-cancelled': 'Image read cancelled.',
} as const;
/** Main could not Copy from a transcript, or read a stored image for it, for `problem`. */
export class TranscriptNativeError extends Schema.TaggedError<TranscriptNativeError>()(
  'TranscriptNativeError',
  {
    problem: Schema.Literals(Object.keys(transcriptProblems) as [keyof typeof transcriptProblems]),
  },
) {
  override get message(): string {
    return transcriptProblems[this.problem];
  }
}

/** Text a window reports to main, or main to it, of a failed cleanup: Moonbase's own, bounded. */
const WindowFailureTextSchema = Schema.String.check(
  Schema.isMaxLength(ipcLimits.errorMessageLength),
);
/** A cleanup failure the window's document and main tell each other of, as the text it shows. */
export class WindowFailure extends Schema.TaggedError<WindowFailure>()('WindowFailure', {
  text: WindowFailureTextSchema,
}) {
  override get message(): string {
    return this.text;
  }
}
/** `text` as a window failure, cut to what may cross IPC. */
export const makeWindowFailure = (text: string) =>
  new WindowFailure({ text: text.slice(0, ipcLimits.errorMessageLength) });
