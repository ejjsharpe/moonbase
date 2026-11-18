import { Effect } from 'effect';
import type { ApplicationError } from '@moonbase/contracts/errors';
import type { ChatServiceError } from '@moonbase/contracts/services';
import type {
  ChatCommand,
  ChatEntry,
  ChatInput,
  ChatOutput,
  ChatSnapshot,
  ChatTranscriptSource,
} from '@moonbase/contracts/chat';
import { areJsonValuesEqual } from '@moonbase/contracts/common';
import { isSameTarget } from '../drafts/drafts.ts';
import type { TranscriptDependencies } from './transcript.ts';
import { TranscriptReadError } from './transcript-errors.ts';
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
export type TranscriptFailure = TranscriptReadError | ChatServiceError | ApplicationError;
type PortRead<K extends ChatCommand> = (
  input: ChatInput<K>,
) => Effect.Effect<ChatOutput<K>, ChatServiceError | ApplicationError>;

/**
 * One open chat's retained transcript: the state it publishes, the accepted snapshot, the history
 * records and the part content. Every change is synchronous; `publish` bounds what is retained and
 * hands the state on when it changed.
 */
export class TranscriptStore {
  state: TranscriptState = makeEmptyTranscriptState();
  snapshot: ChatSnapshot | undefined;
  /** The entry of the part read last, counted against the summary budget while not retained. */
  selectedEntry: ChatEntry | undefined;
  /** The fixed boundary the running or last Find reported; replay and refresh check against it. */
  findBoundary: FindBoundary = { start: null, upper: undefined };
  readonly history: TranscriptHistory;
  readonly contents: TranscriptContentCache;
  readonly dependencies: TranscriptDependencies;
  private published = this.state;
  private publishedSnapshot: ChatSnapshot | undefined;
  constructor(dependencies: TranscriptDependencies) {
    this.dependencies = dependencies;
    this.contents = new TranscriptContentCache(dependencies.limits.contentBytes);
    this.state.view = dependencies.memory.get(dependencies.backend, dependencies.target);
    const anchor = this.state.view.anchor;
    this.history = new TranscriptHistory(!anchor || isLiveRowKey(anchor.key));
  }
  get failed() {
    return this.state.observation === 'failed';
  }
  /**
   * Whether reads may run: the transcript has not failed and `source`, if given, is this chat's
   * and, when live, the accepted snapshot's connected run.
   */
  isCurrent(source?: ChatTranscriptSource) {
    const { target } = this.dependencies;
    return (
      !this.failed &&
      (!source ||
        (isSameTarget(source.target, target) &&
          (source.kind === 'entry' ||
            (this.snapshot?.observationStatus !== 'reconnecting' &&
              areJsonValuesEqual(this.snapshot?.run?.transcript?.source, source)))))
    );
  }
  /**
   * One port read while `source` is current. A snapshot or failure that makes it stale while the
   * read runs interrupts it, so a reply that lands just then is dropped as well.
   */
  read<K extends ChatCommand>(
    operation: K,
    input: ChatInput<K>,
    source?: ChatTranscriptSource,
  ): Effect.Effect<ChatOutput<K>, TranscriptFailure> {
    const chat = this.dependencies.chat as unknown as { [P in K]: PortRead<K> };
    return Effect.suspend((): Effect.Effect<ChatOutput<K>, TranscriptFailure> =>
      this.isCurrent(source)
        ? chat[operation](input)
        : Effect.fail(new TranscriptReadError({ problem: 'source-changed' })),
    ).pipe(Effect.tap(() => (this.isCurrent(source) ? Effect.void : Effect.interrupt)));
  }
  /** Remembers `view`, decoded and frozen; throws a `TranscriptReadError` for an invalid one. */
  rememberView(view: TranscriptView) {
    const { memory, backend, target } = this.dependencies;
    const remembered = memory.set(backend, target, view);
    this.state = { ...this.state, view: remembered };
    return remembered;
  }
  /** Summary budgets count each retained entry/part once, from cached per-value byte sizes. */
  private enforceBounds(direction: HistoryDirection | undefined) {
    const others = new Map((this.snapshot?.entries ?? []).map((entry) => [entry.id, entry]));
    if (this.selectedEntry) others.set(this.selectedEntry.id, this.selectedEntry);
    const sizes = new Map([...others].map(([id, entry]) => [id, measureTranscriptValue(entry)]));
    for (const entry of this.history.records) sizes.set(entry.id, measureTranscriptValue(entry));
    const manifest = this.state.manifest;
    let summaries = sizes.size + (manifest?.parts.length ?? 0);
    let bytes = countTranscriptBytes({
      manifest: manifest && { ...manifest, parts: [] },
      navigation: this.history.navigationState,
    });
    bytes += measureTranscriptValue(this.state.view);
    for (const size of sizes.values()) bytes += size;
    for (const part of manifest?.parts ?? []) bytes += measureTranscriptValue(part);
    const { summaryRecords, summaryBytes } = this.dependencies.limits;
    while (summaries > summaryRecords || bytes > summaryBytes) {
      if (this.state.manifest?.parts.length) {
        const [part, ...parts] = this.state.manifest.parts;
        summaries--;
        bytes -= measureTranscriptValue(part);
        this.state = {
          ...this.state,
          manifest: {
            ...this.state.manifest,
            parts,
            omittedParts: this.state.manifest.omittedParts + 1,
          },
        };
      } else {
        const anchor = this.state.view.anchor;
        const removed = this.history.evictRecord(
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
  }
  /**
   * Publishes when the state or the accepted snapshot changed, keeping an unchanged state's
   * identity. `direction` is the page read that grew the records, which evicts from the end it
   * moved away from.
   */
  publish(direction?: HistoryDirection): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.enforceBounds(direction);
      const listed = this.history.listRecords();
      const previous = this.state.entries;
      const entries =
        listed.length === previous.length &&
        listed.every((entry, index) => entry === previous[index])
          ? previous
          : listed;
      const later = this.history.hasLater();
      this.state = {
        ...this.state,
        entries,
        // The live response follows the newest stored entry, so it shows once history reaches it.
        rows: listTranscriptRows(entries, later ? null : this.snapshot?.run, this.state.rows),
        dataset: this.history.dataset,
        earlier: this.history.hasEarlier(),
        later,
        atLatest: this.history.following,
        content: this.contents.listContents(),
      };
      const changed = !areJsonValuesEqual(this.published, this.state);
      if (changed) this.published = this.state;
      else this.state = this.published;
      const snapshot = this.snapshot === this.publishedSnapshot ? undefined : this.snapshot;
      if (!changed && !snapshot) return Effect.void;
      this.publishedSnapshot = this.snapshot;
      return this.dependencies.publish(this.state, snapshot);
    });
  }
}
