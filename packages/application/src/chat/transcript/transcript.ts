import { Effect, Fiber, type Scope, type SubscriptionRef } from 'effect';
import type {
  ChatSnapshot,
  ChatSummary,
  ChatTarget,
  ChatTranscriptSelection,
  ChatTranscriptSource,
} from '@moonbase/contracts/chat';
import { areJsonValuesEqual } from '@moonbase/contracts/common';
import type { ChatPort } from '../chat-ports.ts';
import { describeChatFailure } from '../chat-errors.ts';
import { checkTranscript, type TranscriptReadError } from './transcript-errors.ts';
import type { TranscriptView, TranscriptViewMemory } from './transcript-view-memory.ts';
import type { TranscriptLimits, TranscriptState } from './transcript-state.ts';
import { isContentChanged } from './transcript-content.ts';
import { checkSnapshotSources, reuseSnapshot } from './transcript-history.ts';
import { isManifestChanged } from './transcript-manifest.ts';
import { isSourceCurrent, makeTranscriptStore } from './transcript-store.ts';
import { makeTranscriptJobs, manifestJob } from './transcript-jobs.ts';
import { makeTranscriptSearch } from './transcript-search.ts';
import { makeTranscriptNavigation } from './transcript-navigation.ts';
import { makeTranscriptLoads, type TranscriptLoads } from './transcript-loads.ts';

export type TranscriptDependencies = {
  chat: ChatPort;
  target: ChatTarget;
  backend: string;
  memory: TranscriptViewMemory;
  /** A chat on this machine is read in place ('local' observation); one over a connection streams. */
  local: boolean;
  limits: TranscriptLimits;
};

/**
 * One open chat's transcript. Each method's Effect ends when the read it starts settles (or is
 * superseded); read failures are published on the state, never failed with.
 */
export type Transcript = {
  /** What the transcript shows, with the accepted snapshot; set only when it changes. */
  readonly state: SubscriptionRef.SubscriptionRef<TranscriptState>;
  /** Whether the transcript failed (observation 'failed'); it stays failed until reopened. */
  readonly failed: Effect.Effect<boolean>;
  /** Trusts the decoded, bounded snapshot; checks only its authority (fails if it belongs elsewhere). */
  readonly acceptSnapshot: (snapshot: ChatSnapshot) => Effect.Effect<void, TranscriptReadError>;
  /** Shows a newer summary of this chat (the caller matched its target) until the next snapshot. */
  readonly updateConversation: (conversation: ChatSummary) => Effect.Effect<void>;
  /** Shows the last accepted snapshot as reconnecting while the watch is reopened. */
  readonly markReconnecting: Effect.Effect<void>;
  /** Fails the transcript with the failure's text (describeChatFailure). */
  readonly fail: (error: unknown) => Effect.Effect<void>;
  readonly restoreView: Effect.Effect<void>;
  readonly openFind: Effect.Effect<void>;
  readonly closeFind: Effect.Effect<void>;
  readonly cancelFindReveal: Effect.Effect<void>;
  readonly findTranscript: (query: string) => Effect.Effect<void>;
  readonly moveFind: (direction: 'next' | 'previous') => Effect.Effect<void>;
  readonly showEarlier: Effect.Effect<void>;
  readonly showLater: Effect.Effect<void>;
  readonly jumpToEntry: (entryId: string) => Effect.Effect<void>;
  readonly jumpToLatest: Effect.Effect<void>;
  /** Fails on an invalid view (view memory decodes it). */
  readonly setView: (view: TranscriptView) => Effect.Effect<void, TranscriptReadError>;
  /**
   * Saves the view `update` makes of the current one, read and saved in one step; one that returns
   * the current view unchanged saves nothing.
   */
  readonly updateView: (
    update: (view: TranscriptView) => TranscriptView,
  ) => Effect.Effect<void, TranscriptReadError>;
  readonly loadManifest: (source: ChatTranscriptSource, restart?: boolean) => Effect.Effect<void>;
  readonly loadMoreParts: TranscriptLoads['loadMoreParts'];
  readonly replayManifest: TranscriptLoads['replayManifest'];
  readonly loadPart: (
    source: ChatTranscriptSource,
    selection: ChatTranscriptSelection,
    restart?: boolean,
  ) => Effect.Effect<void>;
};

/**
 * One open chat's transcript, for as long as the scope: closing it interrupts every read. Reads
 * run in fibers of the scope, keyed (history, manifest, each part), for Find's search and for its
 * reveal; superseding or cancelling a read interrupts its fiber, so a late reply never lands.
 */
export const makeTranscript = (
  dependencies: TranscriptDependencies,
): Effect.Effect<Transcript, never, Scope.Scope> =>
  Effect.gen(function* () {
    const store = yield* makeTranscriptStore(dependencies);
    const jobs = yield* makeTranscriptJobs(store);
    const search = yield* makeTranscriptSearch(store, jobs, (entryId) =>
      navigation.revealEntry(entryId),
    );

    const acceptSnapshot = (input: ChatSnapshot) =>
      Effect.andThen(
        checkTranscript(() => checkSnapshotSources(input, dependencies.target)),
        Effect.withFiber((self) => {
          let stopped: readonly Fiber.Fiber<void>[] = [];
          // Marking reads stale, interrupting them and publishing are one synchronous step, so no
          // reply resumes between them and writes over the marks.
          const accepted = store.update((state) => {
            const old = state.snapshot ?? undefined;
            const next = reuseSnapshot(input, old, store.history);
            store.history.acceptSnapshot(next.entries, old, input);
            const reconnecting = input.observationStatus === 'reconnecting';
            const upper = store.findBoundary.upper;
            const stopFind = reconnecting && !!state.find.query;
            if (stopFind) search.forgetFind();
            // Parts and a manifest whose source the snapshot made stale, or that it changed.
            const isCurrent = (source: ChatTranscriptSource) =>
              isSourceCurrent(dependencies.target, next, source);
            const stale = new Set(
              store.contents.markStale(
                (content) => !isCurrent(content.source) || isContentChanged(content, next),
              ),
            );
            const { manifest } = state;
            const manifestStale =
              !!manifest && (!isCurrent(manifest.source) || isManifestChanged(manifest, old, next));
            if (manifestStale) stale.add(manifestJob);
            // Find while reconnecting, and reads of a live source the snapshot made stale, and of
            // what it changed.
            stopped = [
              ...(stopFind ? search.interruptFindUnsafe(self.id) : []),
              ...jobs.interruptUnsafe(
                ({ source }, key) =>
                  stale.has(key) || (source?.kind === 'live' && !isCurrent(source)),
                self.id,
              ),
            ];
            let observation: TranscriptState['observation'] = dependencies.local
              ? 'local'
              : 'streaming';
            if (reconnecting) observation = 'reconnecting';
            const find = {
              ...state.find,
              refreshAvailable: upper !== undefined && upper !== input.transcriptBoundary,
            };
            return {
              ...state,
              snapshot: old && areJsonValuesEqual(old, next) ? old : next,
              observation,
              find: stopFind
                ? {
                    ...find,
                    revealing: false,
                    status: 'error',
                    error: 'Connection changed. Refresh results after reconnecting.',
                  }
                : find,
              manifest:
                manifest && manifestStale
                  ? {
                      ...manifest,
                      status: 'source-changed',
                      error: 'Transcript source changed or is stale. Reload the manifest.',
                    }
                  : manifest,
            };
          });
          return Effect.andThen(
            accepted,
            Effect.suspend(() => Fiber.awaitAll(stopped)),
          );
        }),
      ).pipe(Effect.asVoid);

    const navigation = makeTranscriptNavigation(store, jobs, {
      acceptSnapshot,
      cancelFindReveal: search.cancelFindReveal,
    });
    const loads = makeTranscriptLoads(store, jobs);

    return {
      state: store.ref,
      failed: Effect.sync(() => store.failed),
      acceptSnapshot,
      updateConversation: (conversation) =>
        store.update((state) =>
          state.snapshot ? { ...state, snapshot: { ...state.snapshot, conversation } } : state,
        ),
      markReconnecting: Effect.suspend(() => {
        const { snapshot } = store.state;
        return snapshot && store.isCurrent()
          ? // The snapshot passed its authority check when it was accepted.
            Effect.orDie(acceptSnapshot({ ...snapshot, observationStatus: 'reconnecting' }))
          : Effect.void;
      }),
      fail: (error) =>
        Effect.withFiber((self) => {
          const failure = describeChatFailure(error);
          let stopped: readonly Fiber.Fiber<void>[] = [];
          // Marking, publishing and interrupting every read (failing stops new ones) are one
          // synchronous step, so no reply resumes between them and writes over the failure, and
          // interrupted loads keep their failure rather than `partial`.
          const failed = store.update((state) => {
            store.contents.markFailed(failure);
            search.forgetFind();
            stopped = [
              ...search.interruptFindUnsafe(self.id),
              ...jobs.interruptUnsafe(() => true, self.id),
            ];
            const { manifest, find } = state;
            return {
              ...state,
              observation: 'failed',
              find: find.query
                ? { ...find, revealing: false, status: 'error', error: failure }
                : { ...find, revealing: false },
              loading: false,
              error: failure,
              ...(manifest && (manifest.source.kind === 'live' || manifest.status === 'loading')
                ? {
                    manifest: {
                      ...manifest,
                      status: manifest.source.kind === 'live' ? 'source-changed' : 'error',
                      error: failure,
                    },
                  }
                : {}),
            };
          });
          return Effect.andThen(
            failed,
            Effect.suspend(() => Fiber.awaitAll(stopped)),
          ).pipe(Effect.asVoid);
        }),
      restoreView: navigation.restoreView,
      openFind: search.openFind,
      closeFind: search.closeFind,
      cancelFindReveal: search.cancelFindReveal,
      findTranscript: search.findTranscript,
      moveFind: search.moveFind,
      showEarlier: navigation.showEarlier,
      showLater: navigation.showLater,
      jumpToEntry: navigation.jumpToEntry,
      jumpToLatest: navigation.jumpToLatest,
      setView: navigation.setView,
      updateView: navigation.updateView,
      loadManifest: loads.loadManifest,
      loadMoreParts: loads.loadMoreParts,
      replayManifest: loads.replayManifest,
      loadPart: loads.loadPart,
    } satisfies Transcript;
  });
