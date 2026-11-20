import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberHandle,
  Layer,
  Option,
  Ref,
  Stream,
  SubscriptionRef,
} from 'effect';
import type {
  ChatSnapshot,
  ChatSummary,
  ChatTarget,
  ChatTranscriptMatch,
  ChatTranscriptSelection,
  ChatTranscriptSource,
} from '@moonbase/contracts/chat';
import { ChatConfig } from '../chat-config.ts';
import { ChatRefusedError, isChatUnavailable } from '../chat-errors.ts';
import { ChatActions } from '../actions/actions-service.ts';
import { ChatDrafts } from '../drafts/drafts-service.ts';
import { isSameSession, isSameTarget } from '../drafts/drafts.ts';
import { ChatLink } from '../link/link-service.ts';
import { retryWatch } from '../../watch-retry.ts';
import { makeTranscript, type Transcript } from '../transcript/transcript.ts';
import { makeEmptyTranscriptState, type TranscriptState } from '../transcript/transcript-state.ts';
import type { TranscriptView } from '../transcript/transcript-view-memory.ts';

/** The open chat: its target and transcript. */
type OpenChat = { readonly target: ChatTarget; readonly transcript: Transcript };

export type SelectionState = {
  open: OpenChat | null;
  /** The open chat's transcript state (with its snapshot), or an empty one while none is open. */
  transcript: SubscriptionRef.SubscriptionRef<TranscriptState>;
};

export type ChatSelectionShape = {
  readonly state: SubscriptionRef.SubscriptionRef<SelectionState>;
  /**
   * Selects a chat and opens it once its host is verified (until then, refresh opens the selected
   * chat). The selection is kept with the drafts.
   */
  readonly select: (target: ChatTarget) => Effect.Effect<void>;
  /** Closes the open chat and keeps no selection. */
  readonly closeView: Effect.Effect<void>;
  /**
   * Closes `target`'s chat after a write that deselected it, without writing again: only while no
   * chat is selected and `target` was the last one opened, so a newer selection stays open.
   */
  readonly closeDeselected: (target: ChatTarget) => Effect.Effect<void>;
  /**
   * Opens `target`'s chat unless it is open: watches it for as long as the link lives, re-watching
   * a watch that fails `Unavailable` on the shared backoff. Succeeds once the first snapshot is
   * read and the saved reading position restored.
   */
  readonly open: (target: ChatTarget) => Effect.Effect<void, unknown>;
  /** Closes the open chat. */
  readonly close: Effect.Effect<void>;
  readonly isOpen: Effect.Effect<boolean>;
  /** Shows a newer summary of the open chat until its next snapshot. */
  readonly updateConversation: (summary: ChatSummary) => Effect.Effect<void>;
  readonly showEarlier: Effect.Effect<void>;
  readonly showLater: Effect.Effect<void>;
  readonly openFind: Effect.Effect<void>;
  readonly closeFind: Effect.Effect<void>;
  readonly cancelFindReveal: Effect.Effect<void>;
  readonly findTranscript: (query: string) => Effect.Effect<void>;
  readonly nextFindMatch: Effect.Effect<void>;
  readonly previousFindMatch: Effect.Effect<void>;
  readonly jumpToEntry: (entryId: string) => Effect.Effect<void>;
  readonly jumpToLatest: Effect.Effect<void>;
  readonly setTranscriptView: (view: TranscriptView) => Effect.Effect<void>;
  /**
   * Saves the view `update` makes of the transcript's current one while `target` is open, read and
   * saved in one step (returning it unchanged saves nothing); a view of a chat no longer open is
   * dropped.
   */
  readonly updateTranscriptView: (
    target: ChatTarget,
    update: (view: TranscriptView) => TranscriptView,
  ) => Effect.Effect<void>;
  readonly loadTranscriptManifest: (
    source: ChatTranscriptSource,
    restart?: boolean,
  ) => Effect.Effect<void>;
  /** A row's Load more parts (`Transcript.loadMoreParts`). */
  readonly loadMoreTranscriptParts: (source: ChatTranscriptSource) => Effect.Effect<void>;
  /**
   * Reads `source`'s manifest again from its start (`Transcript.replayManifest`); true if `match`
   * is still Find's active match once it has read, false if no transcript read it.
   */
  readonly replayTranscriptManifest: (
    source: ChatTranscriptSource,
    match: ChatTranscriptMatch | null,
  ) => Effect.Effect<boolean>;
  readonly loadTranscriptPart: (
    source: ChatTranscriptSource,
    selection: ChatTranscriptSelection,
    restart?: boolean,
  ) => Effect.Effect<void>;
};

/** Which chat is selected and open, and its transcript. */
export class ChatSelection extends Context.Service<ChatSelection, ChatSelectionShape>()(
  'moonbase/chat/ChatSelection',
) {
  static readonly layer = Layer.effect(
    ChatSelection,
    Effect.gen(function* () {
      const config = yield* ChatConfig;
      const actions = yield* ChatActions;
      const drafts = yield* ChatDrafts;
      const link = yield* ChatLink;
      const closedView: SelectionState = {
        open: null,
        transcript: yield* SubscriptionRef.make(makeEmptyTranscriptState()),
      };
      const state = yield* SubscriptionRef.make(closedView);
      const opened = yield* FiberHandle.make<never, unknown>();
      /** The target whose opening runs in `opened`, so a second open of it joins. */
      const opening = yield* Ref.make<ChatTarget | null>(null);

      const close = Effect.andThen(
        FiberHandle.clear(opened),
        SubscriptionRef.set(state, closedView),
      );

      /** The open chat for its scope's lifetime: its transcript, watch and re-watches. */
      const watchChat = (target: ChatTarget, ready: Deferred.Deferred<void, unknown>) =>
        Effect.gen(function* () {
          const transcript = yield* makeTranscript({
            chat: config.chat,
            target: structuredClone(target),
            backend: config.backendId,
            memory: config.memory,
            // A chat on this machine is read in place; one over a connection streams.
            local: !config.connection,
            limits: config.limits,
          });
          const open: OpenChat = { target: structuredClone(target), transcript };
          yield* SubscriptionRef.set(state, { open, transcript: transcript.state });
          // Registered after the transcript's, so it runs first: the view clears before it closes.
          yield* Effect.addFinalizer(() =>
            SubscriptionRef.update(state, (s) => (s.open === open ? closedView : s)),
          );
          const accept = (snapshot: ChatSnapshot) =>
            Effect.flatMap(transcript.failed, (failed) =>
              failed
                ? Effect.void
                : transcript
                    .acceptSnapshot(snapshot)
                    .pipe(
                      Effect.catch((error) =>
                        Effect.andThen(transcript.fail(error), actions.report(error)),
                      ),
                    ),
            );
          // A watch delivers until it fails. Hosts send a snapshot as soon as a watch subscribes, so
          // only a watch that stayed up for the healthy period after its first snapshot renews the
          // count of failed watches. Re-watching only reads; it never resends.
          const attempt = (rewatched: boolean, up: Effect.Effect<void>) =>
            Effect.scoped(
              Effect.gen(function* () {
                const received = yield* Ref.make(false);
                const watch = yield* config.chat.watch({ target }).pipe(
                  Stream.runForEach((snapshot) =>
                    Effect.andThen(Effect.andThen(up, Ref.set(received, true)), accept(snapshot)),
                  ),
                  Effect.forkScoped({ startImmediately: true }),
                );
                const read = Effect.flatMap(config.chat.getChat({ target }), (snapshot) =>
                  Effect.flatMap(Ref.get(received), (seen) =>
                    seen ? Effect.void : accept(snapshot),
                  ),
                );
                if (rewatched) yield* read;
                else {
                  // The first read answers the opening; the watch goes on even if it failed.
                  const exit = yield* Effect.exit(read);
                  if (Exit.isSuccess(exit)) yield* transcript.restoreView;
                  yield* Deferred.done(ready, exit);
                }
                yield* Fiber.join(watch);
              }),
            ).pipe(
              Effect.tapError(() => transcript.markReconnecting),
              // A transcript that already failed stays failed until Refresh or reopening.
              Effect.catch((error) =>
                Effect.flatMap(transcript.failed, (failed) =>
                  failed ? Effect.void : Effect.fail(error),
                ),
              ),
            );
          yield* retryWatch(attempt, {
            retryMs: config.limits.watchRetryMs,
            healthyMs: config.limits.watchHealthyMs,
            isRetryable: isChatUnavailable,
          }).pipe(
            Effect.catch((error) => {
              const stopped = isChatUnavailable(error)
                ? new ChatRefusedError({ reason: 'watch-stopped' })
                : error;
              return Effect.andThen(transcript.fail(stopped), actions.report(stopped));
            }),
          );
          return yield* Effect.never;
        });

      const open = (target: ChatTarget) =>
        Effect.gen(function* () {
          // A chat opens only on a host that refresh has verified.
          if (!(yield* link.get).host) return;
          const running = Option.getOrUndefined(yield* FiberHandle.get(opened));
          if (running && isSameTarget(yield* Ref.get(opening), target)) {
            const exit = yield* Fiber.await(running);
            return Exit.isFailure(exit) && !Exit.hasInterrupts(exit) ? yield* exit : undefined;
          }
          const ready = yield* Deferred.make<void, unknown>();
          yield* Ref.set(opening, structuredClone(target));
          const fiber = yield* FiberHandle.run(
            opened,
            link.run(Effect.scoped(watchChat(target, ready))),
          );
          // Superseded (another chat opened, the view closed or the link ended) is no failure.
          return yield* Effect.raceFirst(
            Deferred.await(ready),
            Effect.flatMap(Fiber.await(fiber), (exit) =>
              Exit.isFailure(exit) && !Exit.hasInterrupts(exit) ? exit : Effect.void,
            ),
          );
        });

      /** Runs `work` on the open chat's transcript while the chat accepts actions. */
      const onTranscript = <A, E>(
        work: (transcript: Transcript) => Effect.Effect<A, E>,
      ): Effect.Effect<A | undefined, E> =>
        Effect.gen(function* () {
          if (!(yield* actions.accepting)) return undefined;
          const current = (yield* SubscriptionRef.get(state)).open;
          return current ? yield* work(current.transcript) : undefined;
        });
      const withTranscript = <E>(work: (transcript: Transcript) => Effect.Effect<void, E>) =>
        Effect.asVoid(onTranscript(work));

      return {
        state,
        select: (target) =>
          actions.run(
            'open',
            Effect.gen(function* () {
              const captured = structuredClone(target);
              if (!isSameSession(captured, config.session))
                return yield* new ChatRefusedError({ reason: 'other-context' });
              yield* drafts.commit((saved) => ({ ...structuredClone(saved), selected: captured }));
              yield* link.current;
              yield* close;
              if ((yield* link.get).host) return yield* open(captured);
              // An unverified host: a running Refresh opens the recorded selection; with none
              // running (its last one failed), the Select verifies the host again to open it.
              const verifier = yield* Deferred.await(link.verifier);
              if (!(yield* verifier.refreshing)) yield* verifier.refresh;
            }),
            { duplicate: false },
          ),
        closeView: Effect.gen(function* () {
          if (!(yield* actions.accepting)) return;
          const kept = yield* Effect.exit(
            drafts.commit((saved) => ({ ...structuredClone(saved), selected: null })),
          );
          if (Exit.isFailure(kept)) return yield* actions.report(Cause.squash(kept.cause));
          yield* close;
        }),
        closeDeselected: (target) =>
          Effect.gen(function* () {
            if ((yield* drafts.get).saved.selected) return;
            if (isSameTarget(yield* Ref.get(opening), target)) yield* close;
          }),
        open,
        close,
        isOpen: Effect.map(SubscriptionRef.get(state), (s) => !!s.open),
        updateConversation: (summary) =>
          withTranscript((transcript) =>
            Effect.flatMap(SubscriptionRef.get(state), (s) =>
              s.open && isSameTarget(s.open.target, summary.target)
                ? transcript.updateConversation(summary)
                : Effect.void,
            ),
          ),
        showEarlier: withTranscript((t) => t.showEarlier),
        showLater: withTranscript((t) => t.showLater),
        openFind: withTranscript((t) => t.openFind),
        closeFind: withTranscript((t) => t.closeFind),
        cancelFindReveal: withTranscript((t) => t.cancelFindReveal),
        findTranscript: (query) => withTranscript((t) => t.findTranscript(query)),
        nextFindMatch: withTranscript((t) => t.moveFind('next')),
        previousFindMatch: withTranscript((t) => t.moveFind('previous')),
        jumpToEntry: (entryId) => withTranscript((t) => t.jumpToEntry(entryId)),
        jumpToLatest: withTranscript((t) => t.jumpToLatest),
        setTranscriptView: (view) =>
          withTranscript((t) => t.setView(view).pipe(Effect.catch(actions.report))),
        updateTranscriptView: (target, update) =>
          Effect.gen(function* () {
            if (!(yield* actions.accepting)) return;
            const { open } = yield* SubscriptionRef.get(state);
            if (open && isSameTarget(open.target, target))
              yield* open.transcript.updateView(update).pipe(Effect.catch(actions.report));
          }),
        loadTranscriptManifest: (source, restart) =>
          withTranscript((t) => t.loadManifest(source, restart)),
        loadMoreTranscriptParts: (source) => withTranscript((t) => t.loadMoreParts(source)),
        replayTranscriptManifest: (source, match) =>
          Effect.map(
            onTranscript((t) => t.replayManifest(source, match)),
            (still) => !!still,
          ),
        loadTranscriptPart: (source, selection, restart) =>
          withTranscript((t) => t.loadPart(source, selection, restart)),
      } satisfies ChatSelectionShape;
    }),
  );
}
