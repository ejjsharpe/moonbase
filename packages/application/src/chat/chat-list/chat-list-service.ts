import {
  Context,
  Effect,
  FiberHandle,
  Layer,
  Option,
  Ref,
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect';
import type { ChatListState, ChatOutput, ChatSummary, ChatTarget } from '@moonbase/contracts/chat';
import { ChatConfig } from '../chat-config.ts';
import { ChatRefusedError, isChatUnavailable } from '../chat-errors.ts';
import { ChatActions } from '../actions/actions-service.ts';
import { ChatDrafts } from '../drafts/drafts-service.ts';
import { isSameSession } from '../drafts/drafts.ts';
import { ChatLink } from '../link/link-service.ts';
import { ChatSelection } from '../selection/selection-service.ts';
import { retryWatch } from '../../watch-retry.ts';
import {
  addCreatedChat,
  chatListPages,
  chatReloadPages,
  dedupeChats,
  mergeListing,
  mergeWatchPage,
  settleRow,
  type ChatListShown,
} from './chat-list.ts';

/** What the list knows besides what it shows. */
type Listing = {
  /** Pages the list on screen spans: the first listing's, plus one per Show older. */
  pages: number;
  /** The latest page the list's watch delivered. */
  watched?: ChatListState;
  /** Refresh is reading the first listing; watch pages wait for it. */
  listing: boolean;
  /** A reload is running, and whether another must run after it. */
  reloading: boolean;
  dirty: boolean;
};

export type ChatListShape = {
  readonly state: SubscriptionRef.SubscriptionRef<ChatListShown>;
  /**
   * Refresh's listing: opens the list's watch first, so changes past the first page made while it
   * reads are not missed (its pages wait for the listing and the latest applies after it), then
   * reads up to 16 pages. Fails as the listing failed, keeping the watch.
   */
  readonly listFirst: Effect.Effect<void, unknown>;
  /** Show older: the next page past the list. */
  readonly more: Effect.Effect<void>;
  /**
   * Lists again in the background, through the pages on screen (at most 64), keeping the last list
   * if it fails and any listed chat it did not reach. A call during a reload joins it; with
   * `latest` (the list must show a change made since that reload began) one more runs after it.
   */
  readonly reload: (options?: { latest?: boolean }) => Effect.Effect<void>;
  /**
   * Watches the list again if its watch stopped (as a window becomes visible), listing it again
   * once the watch delivers. A watch that is open or reconnecting is left alone.
   */
  readonly watch: Effect.Effect<void>;
  /** Settles or unsettles a chat on its host, showing the host's reply in the list and open chat. */
  readonly settle: (target: ChatTarget, settled: boolean) => Effect.Effect<void>;
  /** Shows a chat this client just created first. */
  readonly addCreated: (conversation: ChatSummary) => Effect.Effect<void>;
};

/** The chats a host lists, following its chat list watch. Nothing lists on a timer. */
export class ChatList extends Context.Service<ChatList, ChatListShape>()('moonbase/chat/ChatList') {
  static readonly layer = Layer.effect(
    ChatList,
    Effect.gen(function* () {
      const config = yield* ChatConfig;
      const actions = yield* ChatActions;
      const drafts = yield* ChatDrafts;
      const link = yield* ChatLink;
      const selection = yield* ChatSelection;
      const { chat, session, limits } = config;
      const state = yield* SubscriptionRef.make<ChatListShown>({ chats: [], nextChats: null });
      const listing = yield* Ref.make<Listing>({
        pages: 0,
        listing: false,
        reloading: false,
        dirty: false,
      });
      const following = yield* FiberHandle.make<void, never>();
      const reloads = yield* Semaphore.make(1);

      const show = (shown: ChatListShown, pages?: number) =>
        Effect.gen(function* () {
          const chats = dedupeChats(shown.chats);
          yield* SubscriptionRef.set(state, { chats, nextChats: shown.nextChats });
          if (pages !== undefined) yield* Ref.update(listing, (l) => ({ ...l, pages }));
          yield* drafts.seeListed(chats);
        });
      const applyWatched = (page: ChatListState) =>
        Effect.flatMap(SubscriptionRef.get(state), (shown) => {
          const merged = mergeWatchPage(shown, page);
          return show(merged, merged.pages);
        });
      /** Up to `limit` first pages of chats; `next` continues past the `pages` it read. */
      const listPages = (limit: number) =>
        Effect.gen(function* () {
          const chats: ChatSummary[] = [];
          let cursor: string | null = null,
            pages = 0;
          while (pages < limit) {
            const listed: ChatOutput<'listChats'> = yield* chat.listChats({
              session,
              ...(cursor ? { cursor } : {}),
            });
            pages++;
            chats.push(...listed.conversations);
            cursor = listed.nextCursor;
            if (!cursor) break;
          }
          return { chats, next: cursor, pages };
        });

      /**
       * Follows the list's watch: each first page merges into the list, and a reset, a growing
       * count of changed chats the watch let go, or the first page after a failed watch lists
       * again, since chats past the first page may have changed unseen. A watch that fails
       * `Unavailable` is watched again on the shared backoff; after that, or any other failure,
       * the list stays as it is until `watch` or Refresh.
       */
      const follow = (recovering: boolean) =>
        Effect.gen(function* () {
          yield* Ref.update(listing, (l) => ({ ...l, watched: undefined }));
          const attempt = (rewatched: boolean, up: Effect.Effect<void>) =>
            Effect.suspend(() => {
              let reload = rewatched || recovering,
                dropped: number | undefined;
              return chat.watchChatList({ session }).pipe(
                Stream.runForEach((update) =>
                  Effect.gen(function* () {
                    yield* up;
                    const grew = dropped !== undefined && update.dropped !== dropped;
                    dropped = update.dropped;
                    const { listing: first } = yield* Ref.updateAndGet(listing, (l) => ({
                      ...l,
                      watched: update,
                    }));
                    if (!first) yield* applyWatched(update);
                    if (update.reset || reload || grew) {
                      reload = false;
                      yield* actions.fork(reloadChats({ latest: true }));
                    }
                  }),
                ),
              );
            });
          const watch = retryWatch(attempt, {
            retryMs: limits.watchRetryMs,
            healthyMs: limits.watchHealthyMs,
            isRetryable: isChatUnavailable,
          });
          yield* FiberHandle.run(following, Effect.ignore(link.run(watch)));
        });

      const reloadOnce = Effect.gen(function* () {
        const before = (yield* Ref.get(listing)).watched;
        const { pages } = yield* Ref.get(listing);
        const listed = yield* link.run(
          listPages(Math.min(Math.max(pages, chatListPages), chatReloadPages)),
        );
        const merged = mergeListing(yield* SubscriptionRef.get(state), listed);
        yield* show(merged, merged.pages);
        // A watch page that landed while this read is newer than the rows it returned.
        const { watched } = yield* Ref.get(listing);
        if (watched && watched !== before) yield* applyWatched(watched);
      }).pipe(Effect.ignore);

      const reloadChats = ({ latest = false }: { latest?: boolean } = {}) =>
        Effect.gen(function* () {
          if (!(yield* actions.accepting) || !(yield* link.get).ready) return;
          // A call during a reload joins it, unless it needs a listing that begins after now.
          yield* Ref.update(listing, (l) => ({ ...l, dirty: l.dirty || latest || !l.reloading }));
          yield* reloads.withPermits(1)(
            Effect.gen(function* () {
              for (;;) {
                const run = yield* Ref.modify(listing, (l) =>
                  l.dirty
                    ? [true, { ...l, dirty: false, reloading: true }]
                    : [false, { ...l, reloading: false }],
                );
                if (!run) return;
                yield* reloadOnce;
              }
            }),
          );
        });

      return {
        state,
        listFirst: Effect.gen(function* () {
          const endListing = Ref.update(listing, (l) => ({ ...l, listing: false }));
          yield* Ref.update(listing, (l) => ({ ...l, listing: true }));
          yield* follow(false);
          const listed = yield* Effect.exit(link.run(listPages(chatListPages))).pipe(
            Effect.ensuring(endListing),
          );
          if (listed._tag === 'Success')
            yield* show(
              { chats: listed.value.chats, nextChats: listed.value.next },
              listed.value.pages,
            );
          const { watched } = yield* Ref.get(listing);
          if (watched) yield* applyWatched(watched);
          return yield* listed;
        }),
        more: actions.run(
          'chats',
          link.run(
            Effect.gen(function* () {
              const shown = yield* SubscriptionRef.get(state);
              if (!shown.nextChats) return;
              const page = yield* chat.listChats({ session, cursor: shown.nextChats });
              const { pages } = yield* Ref.get(listing);
              yield* show(
                { chats: [...shown.chats, ...page.conversations], nextChats: page.nextCursor },
                pages + 1,
              );
            }),
          ),
        ),
        reload: reloadChats,
        watch: Effect.gen(function* () {
          if (!(yield* actions.accepting) || !(yield* link.get).ready) return;
          if (Option.isSome(yield* FiberHandle.get(following))) return;
          yield* follow(true);
        }),
        settle: (target, settled) =>
          actions.run(
            'settle',
            link.run(
              Effect.gen(function* () {
                const input = { target: structuredClone(target), settled };
                if (!isSameSession(input.target, session))
                  return yield* new ChatRefusedError({ reason: 'other-context' });
                const summary = yield* chat.settleChat(input);
                yield* SubscriptionRef.update(state, (s) => ({
                  ...s,
                  chats: settleRow(s.chats, summary),
                }));
                yield* selection.updateConversation(summary);
                // Without an open watch, nothing else would show the change.
                if (Option.isNone(yield* FiberHandle.get(following)))
                  yield* actions.fork(reloadChats({ latest: true }));
              }),
            ),
          ),
        addCreated: (conversation) =>
          SubscriptionRef.update(state, (s) => ({
            ...s,
            chats: addCreatedChat(s.chats, conversation),
          })),
      } satisfies ChatListShape;
    }),
  );
}
