import * as Schema from 'effect/Schema';
import { chatErrors } from '@moonbase/contracts/chat-errors';
import { folderErrors } from '@moonbase/contracts/folder-errors';
import { providerSetupErrors } from '@moonbase/contracts/provider-errors';
import { hostErrors, RequestReusedError } from '@moonbase/contracts/host-errors';
import {
  ConnectionError,
  HostVerificationError,
  LocalDaemonError,
  type ConnectionFailure,
} from '@moonbase/contracts/connection-errors';
import { CancelledError, UncertainError } from '@moonbase/contracts/errors';
import { recoveryErrors, type WorkspaceError } from '@moonbase/contracts/workspace-errors';
import { fileHostErrors, type WorkspaceHostError } from '@moonbase/contracts/workspace-host-errors';
import type { DaemonLinkError } from '@moonbase/contracts/host-errors';
import type {
  ChatServiceError,
  LocalHostServiceError,
  ProviderSetupServiceError,
} from '@moonbase/contracts/services';
import { ipcLimits } from './ipc-limits.ts';

// What desktop IPC procedures fail with (D14). Each procedure declares exactly what its handler
// can fail with: main's own refusals (contracts' `ipc-errors`, which the application reads too)
// and the errors of the one service it passes the request on to, which cross as their tags and
// fields. The blocks below are those services' error types as classes; each is checked against
// its type, so a block lists no error its service can't fail with and misses none it can.

/** What a `ConnectionService` fails with (`ConnectionFailure`). */
export const connectionFailures = [
  ConnectionError,
  HostVerificationError,
  LocalDaemonError,
  CancelledError,
] as const;
/** What a service reached over a daemon link fails with besides its own (`DaemonLinkError`). */
const daemonLinkErrors = [
  ...hostErrors,
  UncertainError,
  RequestReusedError,
  ...connectionFailures,
] as const;
/** What a `ChatService` fails with (`ChatServiceError`). */
export const chatServiceErrors = [...chatErrors, ...daemonLinkErrors] as const;
/** What a daemon's folder approvals fail with (`LocalHostServiceError`). */
export const localHostServiceErrors = [...folderErrors, ...chatServiceErrors] as const;
/** What provider setup fails with (`ProviderSetupServiceError`). */
export const providerSetupServiceErrors = [...providerSetupErrors, ...daemonLinkErrors] as const;
/** What the daemon's file host fails with (`WorkspaceHostError`). */
export const workspaceHostErrors = [
  ...fileHostErrors,
  UncertainError,
  CancelledError,
  ...localHostServiceErrors,
] as const;
/** What the editor's `WorkspaceService` fails with (`WorkspaceError`). */
export const workspaceServiceErrors = [...workspaceHostErrors, ...recoveryErrors] as const;

type Instances<T extends readonly (abstract new (...args: never) => unknown)[]> = InstanceType<
  T[number]
>;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
// Each block is exactly its service's error type.
const blocksMatchTheirTypes: [
  Same<Instances<typeof connectionFailures>, ConnectionFailure>,
  Same<Instances<typeof daemonLinkErrors>, DaemonLinkError>,
  Same<Instances<typeof chatServiceErrors>, ChatServiceError>,
  Same<Instances<typeof localHostServiceErrors>, LocalHostServiceError>,
  Same<Instances<typeof providerSetupServiceErrors>, ProviderSetupServiceError>,
  Same<Instances<typeof workspaceHostErrors>, WorkspaceHostError>,
  Same<Instances<typeof workspaceServiceErrors>, WorkspaceError>,
] = [true, true, true, true, true, true, true];
void blocksMatchTheirTypes;

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
