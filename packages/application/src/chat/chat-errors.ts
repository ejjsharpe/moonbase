import * as Schema from 'effect/Schema';
import { ApplicationError, type ApplicationErrorCode } from '@moonbase/contracts/errors';
import { getDaemonErrorCode, isDaemonServiceError } from '@moonbase/contracts/chat-legacy-errors';
import { toConnectionApplicationError } from '@moonbase/contracts/connection-errors';

// What the chat application itself refuses or reports (epic #273 D14). Each reason names what
// happened and its message is Moonbase's own. `describeChatFailure` is the one place a failure
// becomes the text the chat shows.

const reasons = {
  'not-connected': ['Unavailable', 'Connect to the configured host first.'],
  'host-mismatch': ['Incompatible', 'Host actor does not match the configured chat context.'],
  'other-context': ['InvalidInput', 'Chat belongs to another context.'],
  'no-folder': ['InvalidInput', 'Choose a working folder to search its files.'],
  'no-settings': ['InvalidInput', 'Choose a folder and model for this chat.'],
  title: ['InvalidInput', 'Use a chat title of 1–200 UTF-8 bytes.'],
  'empty-message': ['InvalidInput', 'Write a message before sending.'],
  'message-text': ['InvalidInput', 'Message must contain valid Unicode and at most 32 KiB.'],
  'too-many-mentions': ['InvalidInput', 'A message can mention at most 32 files.'],
  'mention-path': [
    'InvalidInput',
    'Mention a file by a relative path of at most 1 KiB, without quotes, backslashes, control characters or ./.. segments.',
  ],
  'model-preference': ['InvalidInput', 'Choose a valid model and reasoning effort.'],
  'draft-limit': [
    'InvalidInput',
    '32 conversation drafts are retained. Send or clear an existing draft before starting another conversation.',
  ],
  'created-draft-limit': [
    'InvalidInput',
    'The conversation was created, but the draft limit was reached. Send or clear an existing draft, then retry the original Create.',
  ],
  'pending-limit': ['InvalidInput', 'Resolve an existing pending command before creating another.'],
  'pending-create': [
    'InvalidInput',
    'Resolve the retained new conversation before sending another.',
  ],
  'pending-send': [
    'InvalidInput',
    'Resolve the retained Send before starting another in this chat.',
  ],
  'pending-stop': ['InvalidInput', 'Resolve the captured Stop before requesting it again.'],
  'watch-stopped': [
    'Unavailable',
    'Live updates stopped and could not reconnect. Refresh or reopen the conversation to retry.',
  ],
} as const satisfies Record<string, readonly [ApplicationErrorCode, string]>;
export type ChatRefusalReason = keyof typeof reasons;

/** What the chat refused or could not do, by reason. */
export class ChatRefusedError extends Schema.TaggedError<ChatRefusedError>()('ChatRefusedError', {
  reason: Schema.Literals(Object.keys(reasons) as ChatRefusalReason[]),
}) {
  override get message(): string {
    return reasons[this.reason][1];
  }
  /** The legacy code (D14) the reason had as an `ApplicationError`. */
  get code(): ApplicationErrorCode {
    return reasons[this.reason][0];
  }
}

const storageProblems = {
  unreadable:
    'Saved chat data or storage is unavailable. Preserve the original data; no new mutation can start.',
  'too-large': 'Saved chat data exceeds its bound. Preserve it for recovery.',
  incompatible:
    'Saved drafts have an incompatible context or format. Preserve the existing chat data; use its original host/store/actor.',
  'write-failed':
    'Draft preservation failed or another client changed it. Keep this window open; no new mutation can start.',
  'live-edit':
    'This live edit could not be preserved within the draft bound. Copy it before closing; mutations and Quit are blocked.',
  blocked: 'Draft preservation failed.',
} as const;
export type DraftStorageProblem = keyof typeof storageProblems;

/** The chat's drafts could not be read or kept; mutations stay blocked for the chat's lifetime. */
export class DraftStorageError extends Schema.TaggedError<DraftStorageError>()(
  'DraftStorageError',
  { problem: Schema.Literals(Object.keys(storageProblems) as DraftStorageProblem[]) },
) {
  override get message(): string {
    return storageProblems[this.problem];
  }
  get code(): ApplicationErrorCode {
    return 'Persistence';
  }
}

const isTagged = (value: unknown, tag: string) =>
  value instanceof Error && (value as { _tag?: unknown })._tag === tag;
const isOwnError = (value: unknown): value is ChatRefusedError | DraftStorageError =>
  isTagged(value, 'ChatRefusedError') || isTagged(value, 'DraftStorageError');
const isTranscriptReadError = (value: unknown): value is Error & { code: ApplicationErrorCode } =>
  isTagged(value, 'TranscriptReadError');
const isConnectionFailure = (value: unknown) =>
  isTagged(value, 'ConnectionError') || isTagged(value, 'HostVerificationError');

/**
 * The legacy code of a chat failure (D14), for decisions that still read codes: whether a watch
 * may retry (`Unavailable`) or a read found its source changed (`Conflict`).
 */
export function getChatFailureCode(error: unknown): ApplicationErrorCode | undefined {
  if (ApplicationError.is(error)) return error.code;
  if (isOwnError(error) || isTranscriptReadError(error)) return error.code;
  if (isConnectionFailure(error))
    return toConnectionApplicationError(error as Parameters<typeof toConnectionApplicationError>[0])
      .code;
  if (isDaemonServiceError(error)) return getDaemonErrorCode(error);
  if (isTagged(error, 'CancelledError')) return 'Cancelled';
  return undefined;
}

/** The host could not be reached (a restarted daemon, say): watching again may succeed. */
export const isChatUnavailable = (error: unknown) => getChatFailureCode(error) === 'Unavailable';
/** What a transcript read was reading changed under it. */
export const isChatConflict = (error: unknown) => getChatFailureCode(error) === 'Conflict';

const fixedText = {
  UncertainError: 'The outcome is uncertain. Check it before retrying; do not send it again.',
  UnauthorizedError: 'This request is not authorized.',
} as const;
const fallback = 'Chat action failed.';

/**
 * The text the chat shows for a failure (D14), its one tag-to-text mapping. The chat's own errors,
 * a host's tagged errors and the legacy `ApplicationError` build their message from fixed text and
 * their fields (D11); `UncertainError` and `UnauthorizedError` show fixed text; anything else, such
 * as a defect, shows only fixed text.
 */
export function describeChatFailure(error: unknown): string {
  const tag = error instanceof Error ? (error as { _tag?: unknown })._tag : undefined;
  if (typeof tag === 'string' && Object.hasOwn(fixedText, tag))
    return fixedText[tag as keyof typeof fixedText];
  if (
    ApplicationError.is(error) ||
    isOwnError(error) ||
    isTranscriptReadError(error) ||
    isConnectionFailure(error) ||
    isDaemonServiceError(error) ||
    tag === 'CancelledError'
  )
    return (error as Error).message;
  return fallback;
}
