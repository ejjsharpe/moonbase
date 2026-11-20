import type {
  ChatHostConfiguration,
  ChatMention,
  ChatModelPreference,
  ChatSnapshot,
  ChatSummary,
  ChatTarget,
} from '@moonbase/contracts/chat';
import type { ConnectionSnapshot } from '@moonbase/contracts/connection';
import { Effect, Stream, SubscriptionRef } from 'effect';
import { listActive, type ActionsState } from './actions/actions.ts';
import { ChatActions } from './actions/actions-service.ts';
import { ChatDrafts, type DraftsState } from './drafts/drafts-service.ts';
import type { Pending } from './drafts/drafts.ts';
import { ChatLink, type LinkState } from './link/link-service.ts';
import type { ChatListShown } from './chat-list/chat-list.ts';
import { ChatList } from './chat-list/chat-list-service.ts';
import { ChatSelection } from './selection/selection-service.ts';
import { ChatSends, type SendsState } from './sends/sends-service.ts';
import type { TranscriptState } from './transcript/transcript-state.ts';

/** One chat as a view shows it, read from its services' states. */
export type ChatState = {
  /** Whether the host is reached through a connection that is connected explicitly. */
  remote: boolean;
  ready: boolean;
  connection: ConnectionSnapshot | null;
  host: ChatHostConfiguration | null;
  chats: ChatSummary[];
  nextChats: string | null;
  /** Chats you have looked at and the activity time you saw; absent before the first listing. */
  seen: readonly { conversationId: string; at: string }[] | undefined;
  snapshot: ChatSnapshot | null;
  transcript: TranscriptState;
  selected: ChatTarget | null;
  draft: string;
  /** Files the draft mentions; each is spelled in `draft` (`formatChatMention`). */
  mentions: ChatMention[];
  modelPreference: ChatModelPreference | null;
  pending: Pending[];
  /** Request IDs of pending commands this session is still sending; their outcome is not yet in doubt. */
  dispatching: string[];
  /** The named actions running. */
  active: string[];
  error: string | null;
  storageError: string | null;
  notice: string;
};

/** The chat's state from each concept's. */
export const toChatState = (parts: {
  actions: ActionsState;
  drafts: DraftsState;
  link: LinkState;
  list: ChatListShown;
  /** The open chat's transcript (`ChatSelection`'s), with its snapshot. */
  transcript: TranscriptState;
  sends: SendsState;
}): ChatState => ({
  remote: parts.link.remote,
  ready: parts.link.ready,
  connection: parts.link.connection,
  host: parts.link.host,
  chats: parts.list.chats,
  nextChats: parts.list.nextChats,
  seen: parts.drafts.saved.seen,
  snapshot: parts.transcript.snapshot,
  transcript: parts.transcript,
  selected: parts.drafts.saved.selected,
  draft: parts.drafts.draft,
  mentions: parts.drafts.mentions,
  modelPreference: parts.drafts.saved.modelPreference ?? null,
  pending: parts.drafts.saved.pending,
  dispatching: Object.keys(parts.sends.dispatching),
  active: listActive(parts.actions),
  error: parts.actions.error,
  storageError: parts.drafts.storageError,
  notice: parts.actions.notice,
});

/** The chat's state now, read from its services, for a consumer without atoms. */
export const readChatState = Effect.gen(function* () {
  return toChatState({
    actions: yield* SubscriptionRef.get((yield* ChatActions).state),
    drafts: yield* SubscriptionRef.get((yield* ChatDrafts).state),
    link: yield* SubscriptionRef.get((yield* ChatLink).state),
    list: yield* SubscriptionRef.get((yield* ChatList).state),
    transcript: yield* SubscriptionRef.get(
      (yield* SubscriptionRef.get((yield* ChatSelection).state)).transcript,
    ),
    sends: yield* SubscriptionRef.get((yield* ChatSends).state),
  });
});

/** Signals each change to any part of the chat's state. */
export const watchChatState = Stream.unwrap(
  Effect.gen(function* () {
    const refs = [
      (yield* ChatActions).state,
      (yield* ChatDrafts).state,
      (yield* ChatLink).state,
      (yield* ChatList).state,
      (yield* ChatSends).state,
    ] as const;
    // The open chat's transcript, followed afresh as the selection opens and closes chats.
    const transcript = Stream.switchMap(
      SubscriptionRef.changes((yield* ChatSelection).state),
      (selection) => SubscriptionRef.changes(selection.transcript),
    );
    return Stream.mergeAll(
      [
        ...refs.map((ref) =>
          SubscriptionRef.changes(ref as SubscriptionRef.SubscriptionRef<unknown>),
        ),
        transcript,
      ].map((changes) => Stream.map(changes, () => undefined)),
      { concurrency: 'unbounded' },
    );
  }),
);
