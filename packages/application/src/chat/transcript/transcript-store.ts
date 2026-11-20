import { Effect, Option, SubscriptionRef } from 'effect';
import type { IpcError } from '@moonbase/contracts/ipc-errors';
import type { ChatServiceError } from '@moonbase/contracts/services';
import type {
  ChatEntry,
  ChatSnapshot,
  ChatTarget,
  ChatTranscriptSource,
} from '@moonbase/contracts/chat';
import { areJsonValuesEqual } from '@moonbase/contracts/common';
import { isSameTarget } from '../drafts/drafts.ts';
import type { TranscriptDependencies } from './transcript.ts';
import type { TranscriptReadError } from './transcript-errors.ts';
import type { TranscriptView } from './transcript-view-memory.ts';
import { countTranscriptBytes } from './transcript-read.ts';
import {
  makeEmptyTranscriptState,
  measureTranscriptValue,
  type TranscriptState,
} from './transcript-state.ts';
import { TranscriptContentCache } from './transcript-content.ts';
import { TranscriptHistory, type HistoryDirection } from './transcript-history.ts';
import type { FindBoundary } from './transcript-find.ts';
import { findRowEntryId, isLiveRowKey, listTranscriptRows } from './transcript-rows.ts';

/** What a transcript read fails with: the host's errors, or what the read found wrong. */
export type TranscriptFailure = TranscriptReadError | ChatServiceError | IpcError;

/**
 * Whether reads of `source` may run under `snapshot`: it is this chat's and, when live, the
 * snapshot's connected run.
 */
export const isSourceCurrent = (
  target: ChatTarget,
  snapshot: ChatSnapshot | null,
  source: ChatTranscriptSource,
) =>
  isSameTarget(source.target, target) &&
  (source.kind === 'entry' ||
    (snapshot?.observationStatus !== 'reconnecting' &&
      areJsonValuesEqual(snapshot?.run?.transcript?.source, source)));

/**
 * One open chat's retained transcript. `ref` holds the published state, with the accepted
 * snapshot, changed only through `update`; the history records and the part content are what the
 * rest is derived from, and reach `ref` at the next `update`.
 */
export type TranscriptStore = {
  readonly ref: SubscriptionRef.SubscriptionRef<TranscriptState>;
  /** The published state now. */
  readonly state: TranscriptState;
  readonly failed: boolean;
  readonly history: TranscriptHistory;
  readonly contents: TranscriptContentCache;
  readonly dependencies: TranscriptDependencies;
  /** The entry of the part read last, counted against the summary budget while not retained. */
  selectedEntry: ChatEntry | undefined;
  /** The fixed boundary the running or last Find reported; replay and refresh check against it. */
  findBoundary: FindBoundary;
  /**
   * Whether reads may start: the transcript has not failed and `source`, if given, is this chat's
   * and, when live, the accepted snapshot's connected run. A read that goes stale once started is
   * interrupted instead.
   */
  readonly isCurrent: (source?: ChatTranscriptSource) => boolean;
  /** Remembers `view`, decoded and frozen; throws a `TranscriptReadError` for an invalid one. */
  readonly rememberView: (view: TranscriptView) => TranscriptView;
  /**
   * Applies `change`, bounds what is retained and derives the rows, then publishes if anything
   * changed, keeping an unchanged state's identity. `direction` is the page read that grew the
   * records, which evicts from the end it moved away from. `change` runs in one synchronous step
   * with the publish, holding the state, so it may interrupt the reads it makes stale: none resumes
   * between the two, and one it interrupts publishes how it ended only after this change.
   */
  readonly update: (
    change?: (state: TranscriptState) => TranscriptState,
    direction?: HistoryDirection,
  ) => Effect.Effect<void>;
};

export const makeTranscriptStore = (dependencies: TranscriptDependencies) =>
  Effect.gen(function* () {
    const { memory, backend, target, limits } = dependencies;
    const view = memory.get(backend, target);
    const ref = yield* SubscriptionRef.make({ ...makeEmptyTranscriptState(), view });
    const contents = new TranscriptContentCache(limits.contentBytes);
    const history = new TranscriptHistory(!view.anchor || isLiveRowKey(view.anchor.key));

    /** Summary budgets count each retained entry/part once, from cached per-value byte sizes. */
    const enforceBounds = (input: TranscriptState, direction: HistoryDirection | undefined) => {
      let state = input;
      const others = new Map((state.snapshot?.entries ?? []).map((entry) => [entry.id, entry]));
      if (store.selectedEntry) others.set(store.selectedEntry.id, store.selectedEntry);
      const sizes = new Map([...others].map(([id, entry]) => [id, measureTranscriptValue(entry)]));
      for (const entry of history.records) sizes.set(entry.id, measureTranscriptValue(entry));
      const manifest = state.manifest;
      let summaries = sizes.size + (manifest?.parts.length ?? 0);
      let bytes = countTranscriptBytes({
        manifest: manifest && { ...manifest, parts: [] },
        navigation: history.navigationState,
      });
      bytes += measureTranscriptValue(state.view);
      for (const size of sizes.values()) bytes += size;
      for (const part of manifest?.parts ?? []) bytes += measureTranscriptValue(part);
      const { summaryRecords, summaryBytes } = limits;
      while (summaries > summaryRecords || bytes > summaryBytes) {
        if (state.manifest?.parts.length) {
          const [part, ...parts] = state.manifest.parts;
          summaries--;
          bytes -= measureTranscriptValue(part);
          state = {
            ...state,
            manifest: { ...state.manifest, parts, omittedParts: state.manifest.omittedParts + 1 },
          };
        } else {
          const anchor = state.view.anchor;
          const removed = history.evictRecord(
            direction,
            anchor ? findRowEntryId(anchor.key) : undefined,
          );
          if (!removed) break;
          const other = others.get(removed.id);
          bytes -= sizes.get(removed.id)!;
          if (other) bytes += measureTranscriptValue(other);
          else summaries--;
          sizes.delete(removed.id);
        }
      }
      return state;
    };
    const derive = (published: TranscriptState, direction: HistoryDirection | undefined) => {
      const state = enforceBounds(published, direction);
      const listed = history.listRecords();
      const previous = state.entries;
      const entries =
        listed.length === previous.length &&
        listed.every((entry, index) => entry === previous[index])
          ? previous
          : listed;
      const later = history.hasLater();
      return {
        ...state,
        entries,
        // The live response follows the newest stored entry, so it shows once history reaches it.
        rows: listTranscriptRows(entries, later ? null : state.snapshot?.run, state.rows),
        dataset: history.dataset,
        earlier: history.hasEarlier(),
        later,
        atLatest: history.following,
        content: contents.listContents(),
      };
    };
    /** The accepted snapshot is kept by identity, so only the rest is compared by value. */
    const isSameState = (a: TranscriptState, b: TranscriptState) =>
      a.snapshot === b.snapshot &&
      areJsonValuesEqual({ ...a, snapshot: null }, { ...b, snapshot: null });

    const store: TranscriptStore = {
      ref,
      get state() {
        return SubscriptionRef.getUnsafe(ref);
      },
      get failed() {
        return SubscriptionRef.getUnsafe(ref).observation === 'failed';
      },
      history,
      contents,
      dependencies,
      selectedEntry: undefined,
      findBoundary: { start: null, upper: undefined },
      isCurrent: (source) =>
        !store.failed && (!source || isSourceCurrent(target, store.state.snapshot, source)),
      rememberView: (next) => memory.set(backend, target, next),
      update: (change = (state) => state, direction) =>
        SubscriptionRef.updateSome(ref, (published) => {
          const next = derive(change(published), direction);
          return isSameState(next, published) ? Option.none() : Option.some(next);
        }),
    };
    return store;
  });
