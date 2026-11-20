import * as Schema from 'effect/Schema';
import type { ErrorGroup } from './error-groups.ts';
import { UncertainError } from './errors.ts';
import { FolderRefusedError } from './folder-errors.ts';
import { IncompatibleHostError, RequestReusedError } from './host-errors.ts';

// What the `ChatService` fails with (epic #273 D14), besides the folder, host and shared outcome
// errors its union names. Each error names what happened with a literal and builds its message
// from it, so one decoded from a remote host carries no text the host wrote (D11).

const requestProblems = {
  'unknown-conversation': 'Unknown conversation.',
  'folder-missing': 'Choose an existing local working folder.',
  'folder-not-canonical': 'Choose a canonical local working folder.',
  'folder-required': 'Choose a local working folder for this chat.',
  model: 'Choose an installed model from the local catalog.',
  'reasoning-effort': 'Choose a reasoning effort supported by this model.',
  'stop-submission': 'Stop submission does not belong to this conversation.',
  'stop-task': 'Stop task does not belong to this conversation.',
  cursor: 'Invalid chat cursor.',
  'history-cursor': 'This history cursor belongs to another view or is invalid.',
  'history-direction': 'Invalid history direction.',
  'transcript-cursor': 'Transcript cursor does not belong to this read.',
  entry: 'Entry does not belong to this conversation.',
  part: 'Transcript part is unavailable or invalid.',
  'content-position': 'Invalid content position.',
  'content-split': 'Content selection splits Unicode.',
  text: 'Chat text is empty, invalid Unicode, or exceeds its limit.',
  'find-limit': 'Find match exceeds its delivery limit.',
  'reply-limit': 'Chat reply exceeds its delivery limit.',
  'record-identity': 'Invalid Pi record identity.',
} as const;
/** The request names something the chat host refuses as given. */
export class InvalidChatRequestError extends Schema.TaggedError<InvalidChatRequestError>()(
  'InvalidChatRequestError',
  { problem: Schema.Literals(Object.keys(requestProblems) as (keyof typeof requestProblems)[]) },
) {
  get group(): ErrorGroup {
    return 'refusal';
  }
  override get message() {
    return requestProblems[this.problem];
  }
}

/** The conversation is running another turn; the request is kept to retry explicitly. */
export class ChatBusyError extends Schema.TaggedError<ChatBusyError>()('ChatBusyError', {}) {
  get group(): ErrorGroup {
    return 'conflict';
  }
  override get message() {
    return 'Conversation is busy; retain this request and retry explicitly.';
  }
}

const transcriptChanges = {
  view: 'Transcript source changed; reload the consistent view.',
  'nested-source': 'Nested tool source is unavailable; reload the consistent view.',
  'nested-ended': 'Nested tool source ended; reload the consistent view.',
  'nested-result': 'Retained nested result is unavailable; reload the source.',
  manifest: 'Transcript manifest changed; reload the source.',
  prefix: 'Transcript prefix changed; reload the selected part.',
  part: 'Transcript part disappeared; reload the source.',
} as const;
/** What a transcript read was reading changed under it; reading again sees the new state. */
export class TranscriptChangedError extends Schema.TaggedError<TranscriptChangedError>()(
  'TranscriptChangedError',
  {
    change: Schema.Literals(Object.keys(transcriptChanges) as (keyof typeof transcriptChanges)[]),
  },
) {
  get group(): ErrorGroup {
    return 'conflict';
  }
  override get message() {
    return transcriptChanges[this.change];
  }
}

const accessRefusals = {
  'other-actor': 'This personal chat belongs to another actor.',
  'other-owner': 'Conversation does not belong to this configured actor/store.',
  'store-authority': 'Chat store authority changed. Preserve this store.',
} as const;
/** The conversation is not this caller's. */
export class ChatAccessError extends Schema.TaggedError<ChatAccessError>()('ChatAccessError', {
  refusal: Schema.Literals(Object.keys(accessRefusals) as (keyof typeof accessRefusals)[]),
}) {
  get group(): ErrorGroup {
    return 'access';
  }
  override get message() {
    return accessRefusals[this.refusal];
  }
}

const storeProblems = {
  failed:
    'Pi storage or execution is unavailable. Reopen this explicit store after resolving its failure.',
  'invalid-data': 'Stored Moonbase chat data is invalid; preserve this store without rewriting it.',
  authority: 'Stored Moonbase chat authority is invalid.',
  binding: 'Stored Moonbase request binding is invalid.',
  'request-conversation': 'Stored Moonbase request conversation is invalid.',
  'request-state': 'Stored Moonbase request state is invalid.',
  'request-authority': 'Stored Moonbase request authority is invalid.',
  'pending-intent': 'Stored pending-intent metadata is invalid.',
  'admission-identity': 'Stored admission identity is invalid.',
  'admission-type': 'Stored admission has an incompatible type.',
  'settings-missing': 'Stored local conversation settings are missing; preserve this store.',
  'live-state': 'Pi live state is unavailable. Reopen this conversation.',
  'live-replaced': 'Pi live state was replaced. Reopen this conversation.',
  'live-task': 'Live task authority is invalid.',
  'live-tool': 'Live tool authority is invalid.',
  'nested-tool': 'Nested tool authority is invalid.',
  'nested-call': 'Nested tool call identity is invalid.',
  'nested-parent': 'Nested tool parent authority is invalid.',
  'nested-result': 'Retained nested result identity is invalid.',
  'tool-result': 'Recorded tool result is unavailable.',
} as const;
/** The chat store failed, or holds a record that is not what Moonbase wrote; it is kept as it is. */
export class ChatStoreError extends Schema.TaggedError<ChatStoreError>()('ChatStoreError', {
  problem: Schema.Literals(Object.keys(storeProblems) as (keyof typeof storeProblems)[]),
}) {
  get group(): ErrorGroup {
    return 'storage';
  }
  override get message() {
    return storeProblems[this.problem];
  }
}

const storeMismatches = {
  'other-host': 'Chat host/store does not match this host.',
  unowned: 'This store contains data without Moonbase ownership metadata; no import is authorized.',
  bound: 'Store is already bound to another host, actor, working directory or model.',
} as const;
/** The chat store belongs to another host, actor or configuration, or to nobody Moonbase knows. */
export class ChatStoreMismatchError extends Schema.TaggedError<ChatStoreMismatchError>()(
  'ChatStoreMismatchError',
  {
    mismatch: Schema.Literals(Object.keys(storeMismatches) as (keyof typeof storeMismatches)[]),
  },
) {
  get group(): ErrorGroup {
    return 'incompatible';
  }
  override get message() {
    return storeMismatches[this.mismatch];
  }
}

const unavailable = {
  quitting: 'Local chat is preparing to quit.',
  'watch-failed': 'Chat updates stopped; they are read again shortly.',
  observers: 'Chat observation is unavailable.',
  'own-folder-in-checkout':
    'Chats without a project are unavailable while Moonbase’s data folder is inside a Git checkout. Choose a working folder.',
  'own-folder-failed': 'A folder for the new chat could not be made.',
  'saved-folder-missing':
    'The saved local working folder is unavailable. Restore it before retrying.',
  'file-search':
    'File search needs ripgrep or Git on the chat host, and a readable working folder.',
} as const;
/** The chat host can't do this now: it is quitting, or something the request needs is missing. */
export class ChatUnavailableError extends Schema.TaggedError<ChatUnavailableError>()(
  'ChatUnavailableError',
  { reason: Schema.Literals(Object.keys(unavailable) as (keyof typeof unavailable)[]) },
) {
  get group(): ErrorGroup {
    return 'unavailable';
  }
  override get message() {
    return unavailable[this.reason];
  }
}

/** The error classes a `ChatService` fails with: the ones above and those it shares. */
export const chatErrors = [
  InvalidChatRequestError,
  ChatBusyError,
  TranscriptChangedError,
  ChatAccessError,
  ChatStoreError,
  ChatStoreMismatchError,
  ChatUnavailableError,
  FolderRefusedError,
  RequestReusedError,
  IncompatibleHostError,
  UncertainError,
] as const;
/** Every way a chat host's `ChatService` fails. */
export type ChatError = InstanceType<(typeof chatErrors)[number]>;
/** Whether `value` is one of the chat host's errors. */
export const isChatError: (value: unknown) => value is ChatError = Schema.is(
  Schema.Union(chatErrors),
);
