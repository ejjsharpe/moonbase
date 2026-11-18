import { Effect, Fiber, type Scope } from 'effect';
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
import { TranscriptStore } from './transcript-store.ts';
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
  /** Publishes the state, with the accepted snapshot when it changed (else undefined). */
  publish: (state: TranscriptState, snapshot: ChatSnapshot | undefined) => Effect.Effect<void>;
};

/**
 * One open chat's transcript. Each method's Effect ends when the read it starts settles (or is
 * superseded); read failures are published on the state, never failed with.
 */
export type Transcript = {
  readonly state: Effect.Effect<TranscriptState>;
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
    const store = new TranscriptStore(dependencies);
    const jobs = yield* makeTranscriptJobs(store);
    const search = yield* makeTranscriptSearch(store, jobs, (entryId) =>
      navigation.revealEntry(entryId),
    );

    const acceptSnapshot = (input: ChatSnapshot) =>
      Effect.gen(function* () {
        yield* checkTranscript(() => checkSnapshotSources(input, dependencies.target));
        // Marking reads stale and interrupting them are one synchronous step, so a reply can't
        // land between them and overwrite the mark.
        const { stopFind, stopped } = yield* Effect.withFiber((parent) => {
          const old = store.snapshot;
          const next = reuseSnapshot(input, old, store.history);
          store.snapshot = old && areJsonValuesEqual(old, next) ? old : next;
          const reconnecting = input.observationStatus === 'reconnecting';
          const upper = store.findBoundary.upper;
          let observation: TranscriptState['observation'] = dependencies.local
            ? 'local'
            : 'streaming';
          if (reconnecting) observation = 'reconnecting';
          store.state = {
            ...store.state,
            observation,
            find: {
              ...store.state.find,
              refreshAvailable: upper !== undefined && upper !== input.transcriptBoundary,
            },
          };
          const stopFind = reconnecting && !!store.state.find.query;
          if (stopFind) {
            search.forgetFind();
            store.state = {
              ...store.state,
              find: {
                ...store.state.find,
                status: 'error',
                error: 'Connection changed. Refresh results after reconnecting.',
              },
            };
          }
          store.history.acceptSnapshot(next.entries, old, input);
          // Reads of a live source the snapshot made stale, and of parts or a manifest it changed.
          const stale = new Set(
            jobs.keys(({ source }) => source?.kind === 'live' && !store.isCurrent(source)),
          );
          const changed = store.contents.markStale(
            (content) => !store.isCurrent(content.source) || isContentChanged(content, next),
          );
          for (const key of changed) stale.add(key);
          const manifest = store.state.manifest;
          if (
            manifest &&
            (!store.isCurrent(manifest.source) || isManifestChanged(manifest, old, next))
          ) {
            store.state = {
              ...store.state,
              manifest: {
                ...manifest,
                status: 'source-changed',
                error: 'Transcript source changed or is stale. Reload the manifest.',
              },
            };
            stale.add(manifestJob);
          }
          const stopped = jobs.fibers((_read, key) => stale.has(key));
          for (const fiber of stopped) fiber.interruptUnsafe(parent.id);
          return Effect.succeed({ stopFind, stopped });
        });
        if (stopFind) yield* search.stopFind;
        yield* Fiber.awaitAll(stopped);
        yield* store.publish();
      });

    const navigation = makeTranscriptNavigation(store, jobs, {
      acceptSnapshot,
      cancelFindReveal: search.cancelFindReveal,
    });
    const loads = makeTranscriptLoads(store, jobs);

    return {
      state: Effect.sync(() => store.state),
      failed: Effect.sync(() => store.failed),
      acceptSnapshot,
      updateConversation: (conversation) =>
        Effect.suspend(() => {
          if (!store.snapshot) return Effect.void;
          store.snapshot = { ...store.snapshot, conversation };
          return store.publish();
        }),
      markReconnecting: Effect.suspend(() =>
        store.snapshot && store.isCurrent()
          ? // The snapshot passed its authority check when it was accepted.
            Effect.orDie(acceptSnapshot({ ...store.snapshot, observationStatus: 'reconnecting' }))
          : Effect.void,
      ),
      fail: (error) =>
        Effect.suspend(() => {
          const failure = describeChatFailure(error);
          // Mark before interrupting, so interrupted loads keep their failure rather than `partial`.
          store.contents.markFailed(failure);
          const { manifest, find } = store.state;
          store.state = {
            ...store.state,
            observation: 'failed',
            find: find.query ? { ...find, status: 'error', error: failure } : find,
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
          search.forgetFind();
          return search.stopFind.pipe(
            Effect.andThen(jobs.interrupt(() => true)),
            Effect.andThen(store.publish()),
          );
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
