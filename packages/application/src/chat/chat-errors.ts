import * as Schema from 'effect/Schema';
import {
  isConflict,
  isKnownError,
  isUnavailable,
  type ErrorGroup,
} from '@moonbase/contracts/error-groups';

// What the chat application itself refuses or reports (epic #273 D14). Each reason names what
// happened, what it means for the request (its `group`) and its message, which is Moonbase's
// own. `describeChatFailure` is the one place a failure becomes the text the chat shows.

const reasons = {
  'not-connected': ['unavailable', 'Connect to the configured host first.'],
  'host-mismatch': ['incompatible', 'Host actor does not match the configured chat context.'],
  'other-context': ['refusal', 'Chat belongs to another context.'],
  'no-folder': ['refusal', 'Choose a working folder to search its files.'],
  'no-settings': ['refusal', 'Choose a folder and model for this chat.'],
  title: ['refusal', 'Use a chat title of 1–200 UTF-8 bytes.'],
  'empty-message': ['refusal', 'Write a message before sending.'],
  'message-text': ['refusal', 'Message must contain valid Unicode and at most 32 KiB.'],
  'too-many-mentions': ['refusal', 'A message can mention at most 32 files.'],
  'mention-path': [
    'refusal',
    'Mention a file by a relative path of at most 1 KiB, without quotes, backslashes, control characters or ./.. segments.',
  ],
  'model-preference': ['refusal', 'Choose a valid model and reasoning effort.'],
  'draft-limit': [
    'refusal',
    '32 conversation drafts are retained. Send or clear an existing draft before starting another conversation.',
  ],
  'created-draft-limit': [
    'refusal',
    'The conversation was created, but the draft limit was reached. Send or clear an existing draft, then retry the original Create.',
  ],
  'pending-limit': ['refusal', 'Resolve an existing pending command before creating another.'],
  'pending-create': ['refusal', 'Resolve the retained new conversation before sending another.'],
  'pending-send': ['refusal', 'Resolve the retained Send before starting another in this chat.'],
  'pending-stop': ['refusal', 'Resolve the captured Stop before requesting it again.'],
  'watch-stopped': [
    'unavailable',
    'Live updates stopped and could not reconnect. Refresh or reopen the conversation to retry.',
  ],
} as const satisfies Record<string, readonly [ErrorGroup, string]>;
export type ChatRefusalReason = keyof typeof reasons;

/** What the chat refused or could not do, by reason. */
export class ChatRefusedError extends Schema.TaggedError<ChatRefusedError>()('ChatRefusedError', {
  reason: Schema.Literals(Object.keys(reasons) as ChatRefusalReason[]),
}) {
  get group(): ErrorGroup {
    return reasons[this.reason][0];
  }
  override get message(): string {
    return reasons[this.reason][1];
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
}

/** Why the rest of a message after `/new` can't join the new chat's draft. */
export class NewChatDraftError extends Schema.TaggedError<NewChatDraftError>()(
  'NewChatDraftError',
  {
    /** `stale`: the chat or its draft changed since the command was typed, so nothing moved. */
    reason: Schema.Literals(['clash', 'full', 'stale']),
    /** The mention whose spelling already names a file in another folder (`clash`). */
    path: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    if (this.reason === 'clash')
      return `The new chat's draft already mentions ${this.path} in another folder, so the rest of this message stays here.`;
    return this.reason === 'full'
      ? "The new chat's draft has no room for the rest of this message, so it stays here."
      : 'The draft changed before /new ran, so nothing moved.';
  }
}

const isDraftStorageError = (value: unknown): value is DraftStorageError =>
  value instanceof Error && (value as { _tag?: unknown })._tag === 'DraftStorageError';

/**
 * The host could not be reached (a restarted daemon, say): watching again may succeed. The chat's
 * own errors declare their group too, so this is `error-groups`' own.
 */
export const isChatUnavailable = isUnavailable;
/** What a transcript read was reading changed under it. */
export const isChatConflict = isConflict;

const fixedText = {
  UncertainError: 'The outcome is uncertain. Check it before retrying; do not send it again.',
  UnauthorizedError: 'This request is not authorized.',
} as const;
const fallback = 'Chat action failed.';

/**
 * The fixed text the chat shows for a shared outcome, `UncertainError` or `UnauthorizedError`,
 * whose own message names the operation; none for any other failure.
 */
export function describeChatOutcome(error: unknown): string | undefined {
  const tag = error instanceof Error ? (error as { _tag?: unknown })._tag : undefined;
  return typeof tag === 'string' && Object.hasOwn(fixedText, tag)
    ? fixedText[tag as keyof typeof fixedText]
    : undefined;
}

/**
 * The text the chat shows for a failure (D14), its one tag-to-text mapping. The chat's own errors,
 * a host's and desktop IPC's build their message from fixed text and their fields (D11);
 * `UncertainError` and `UnauthorizedError` show fixed text; anything else, such as a defect, shows
 * only fixed text.
 */
export function describeChatFailure(error: unknown): string {
  const outcome = describeChatOutcome(error);
  if (outcome !== undefined) return outcome;
  if (isDraftStorageError(error) || isKnownError(error)) return (error as Error).message;
  return fallback;
}
