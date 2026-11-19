import { Context, Effect, Layer, SubscriptionRef } from 'effect';
import type { ChatMention, ChatModelPreference, ChatSummary } from '@moonbase/contracts/chat';
import { ChatConfig } from '../chat-config.ts';
import { ChatRefusedError, DraftStorageError, NewChatDraftError } from '../chat-errors.ts';
import { ChatActions } from '../actions/actions-service.ts';
import {
  countBytes,
  decodeSaved,
  emptySaved,
  keepMentions,
  maximumSavedBytes,
  readDraft,
  recordSeen,
  seeListed,
  writeDraft,
  type Saved,
} from './drafts.ts';

export type DraftsState = {
  saved: Saved;
  /** The draft shown, which an edit storage refused still shows until the chat closes. */
  draft: string;
  /** Files the draft mentions; each is spelled in `draft` (`formatChatMention`). */
  mentions: ChatMention[];
  /** Why drafts can't be kept; it blocks mutations and Quit for the chat's lifetime. */
  storageError: string | null;
  /** What storage held when this chat last read or wrote it; another client's write differs. */
  stored: string | null;
};

/** A draft's text and the files it mentions. */
export type DraftText = { readonly text: string; readonly mentions: readonly ChatMention[] };

export type ChatDraftsShape = {
  readonly state: SubscriptionRef.SubscriptionRef<DraftsState>;
  readonly get: Effect.Effect<DraftsState>;
  /**
   * Keeps `change(saved)`, failing if it isn't valid saved data, if drafts are already blocked, or
   * if storage refuses it or another client changed it (which blocks drafts from then on).
   */
  readonly commit: <E extends ChatRefusedError | NewChatDraftError = never>(
    change: (saved: Saved) => Saved | E,
  ) => Effect.Effect<void, DraftStorageError | E>;
  /**
   * Replaces the draft. `mentions` replaces its mentioned files; otherwise the draft keeps the ones
   * its text still spells, so deleting a mention's text drops the mention. Shows why it couldn't.
   */
  readonly setDraft: (value: string, mentions?: readonly ChatMention[]) => Effect.Effect<void>;
  /**
   * In one write, deselects the open chat, empties its draft and makes the new chat's draft what
   * `join` makes of it, as `/new` carries the rest of a message; every draft stays as it was if
   * `join` refuses (its error) or the write can't be kept (shown, and false).
   */
  readonly moveToNewChat: (
    join: (draft: DraftText) => DraftText | NewChatDraftError,
  ) => Effect.Effect<boolean, NewChatDraftError>;
  readonly setModelPreference: (value: ChatModelPreference) => Effect.Effect<void>;
  /** Records that you saw a chat as of its activity time; an older look never replaces a newer one. */
  readonly markSeen: (conversationId: string, at: string) => Effect.Effect<void>;
  /** On the first listing, records every listed chat as seen. */
  readonly seeListed: (chats: readonly ChatSummary[]) => Effect.Effect<void>;
  /** Keeps the drafts again; false when they can't be kept. */
  readonly preserve: Effect.Effect<boolean>;
};

/** The drafts, selection, pending commands and seen activity a chat keeps in its storage. */
export class ChatDrafts extends Context.Service<ChatDrafts, ChatDraftsShape>()(
  'moonbase/chat/ChatDrafts',
) {
  static readonly layer = Layer.effect(
    ChatDrafts,
    Effect.gen(function* () {
      const { storage, session } = yield* ChatConfig;
      const actions = yield* ChatActions;
      const loaded = yield* Effect.sync(() => {
        try {
          const raw = storage.read();
          if (raw === null) return { raw, saved: emptySaved(session) };
          const saved =
            countBytes(raw) <= maximumSavedBytes
              ? decodeSaved(JSON.parse(raw), session)
              : undefined;
          return saved ? { raw, saved } : undefined;
        } catch {
          return undefined;
        }
      });
      const saved = loaded?.saved ?? emptySaved(session);
      const shown = readDraft(saved);
      const state = yield* SubscriptionRef.make<DraftsState>({
        saved,
        draft: shown.text,
        mentions: shown.mentions,
        storageError: loaded ? null : new DraftStorageError({ problem: 'unreadable' }).message,
        stored: loaded?.raw ?? null,
      });

      // Checking, writing and recording the write are one synchronous step.
      const commit = <E extends ChatRefusedError | NewChatDraftError = never>(
        change: (saved: Saved) => Saved | E,
      ) =>
        SubscriptionRef.modify(state, (s): readonly [DraftStorageError | E | null, DraftsState] => {
          if (s.storageError) return [new DraftStorageError({ problem: 'blocked' }), s];
          const next = change(s.saved);
          if (next instanceof ChatRefusedError || next instanceof NewChatDraftError)
            return [next, s];
          if (!decodeSaved(next, session))
            return [new DraftStorageError({ problem: 'incompatible' }), s];
          const written = JSON.stringify(next);
          try {
            if (countBytes(written) > maximumSavedBytes || storage.read() !== s.stored)
              throw Error();
            storage.write(written);
          } catch {
            const failure = new DraftStorageError({ problem: 'write-failed' });
            return [
              new DraftStorageError({ problem: 'blocked' }),
              { ...s, storageError: failure.message },
            ];
          }
          const draft = readDraft(next);
          return [
            null,
            { ...s, saved: next, draft: draft.text, mentions: draft.mentions, stored: written },
          ];
        }).pipe(
          Effect.flatMap((failure) => (failure ? Effect.fail(failure) : Effect.void)),
        ) as Effect.Effect<void, DraftStorageError | E>;
      const whenAccepting = (work: Effect.Effect<void>) =>
        Effect.flatMap(actions.accepting, (accepting) => (accepting ? work : Effect.void));

      return {
        state,
        get: SubscriptionRef.get(state),
        commit,
        setDraft: (value, mentions) =>
          whenAccepting(
            Effect.gen(function* () {
              const current = yield* SubscriptionRef.get(state);
              const kept = keepMentions(value, mentions ?? current.mentions);
              if (typeof kept === 'string')
                return yield* actions.report(new ChatRefusedError({ reason: kept }));
              yield* SubscriptionRef.update(state, (s) => ({ ...s, draft: value, mentions: kept }));
              yield* commit((saved) => writeDraft(saved, value, kept)).pipe(
                Effect.catch((error) =>
                  Effect.andThen(
                    SubscriptionRef.update(state, (s) => ({
                      ...s,
                      storageError:
                        s.storageError ?? new DraftStorageError({ problem: 'live-edit' }).message,
                    })),
                    actions.report(error),
                  ),
                ),
              );
            }),
          ),
        moveToNewChat: (join) =>
          Effect.gen(function* () {
            if (!(yield* actions.accepting)) return false;
            return yield* commit((saved) => {
              const joined = join(readDraft({ ...saved, selected: null }));
              if (joined instanceof NewChatDraftError) return joined;
              const kept = keepMentions(joined.text, joined.mentions);
              if (typeof kept === 'string') return new ChatRefusedError({ reason: kept });
              return writeDraft(
                { ...writeDraft(saved, '', []), selected: null },
                joined.text,
                kept,
              );
            }).pipe(
              Effect.as(true),
              Effect.catch((error) =>
                error instanceof NewChatDraftError
                  ? Effect.fail(error)
                  : Effect.as(actions.report(error), false),
              ),
            );
          }),
        setModelPreference: (value) =>
          whenAccepting(
            commit((saved) => ({
              ...structuredClone(saved),
              modelPreference: structuredClone(value),
            })).pipe(
              Effect.catch((error) =>
                actions.report(
                  error._tag === 'DraftStorageError' && error.problem === 'incompatible'
                    ? new ChatRefusedError({ reason: 'model-preference' })
                    : error,
                ),
              ),
            ),
          ),
        markSeen: (conversationId, at) =>
          whenAccepting(
            Effect.flatMap(SubscriptionRef.get(state), (s) => {
              const next = !s.storageError && recordSeen(s.saved, conversationId, at);
              return next ? Effect.ignore(commit(() => next)) : Effect.void;
            }),
          ),
        seeListed: (chats) =>
          Effect.flatMap(SubscriptionRef.get(state), (s) =>
            s.saved.seen === undefined && !s.storageError
              ? Effect.ignore(commit((saved) => seeListed(saved, chats)))
              : Effect.void,
          ),
        preserve: Effect.flatMap(SubscriptionRef.get(actions.state), ({ closing }) =>
          closing
            ? Effect.succeed(false)
            : commit((saved) => saved).pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              ),
        ),
      } satisfies ChatDraftsShape;
    }),
  );
}
