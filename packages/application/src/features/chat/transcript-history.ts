import type {
  ChatEntry,
  ChatOutput,
  ChatSnapshot,
  ChatTarget,
  ChatTranscriptPart,
} from '@moonbase/contracts/chat';
import { areJsonValuesEqual } from '@moonbase/contracts/common';
import { sameTarget } from './saved.ts';
import { makeTranscriptFailure } from './transcript-read.ts';

export type HistoryDirection = 'earlier' | 'later';
type AroundPage = ChatOutput<'getChatHistoryAround'>;
type Navigation = {
  entryId: string;
  upperEntryId: string;
  olderCursor: string | null;
  newerCursor: string | null;
  olderEdge: string | undefined;
  newerEdge: string | undefined;
};

export const reuseParts = (previous: ChatTranscriptPart[], next: ChatTranscriptPart[]) =>
  next.map((part) => {
    const old = previous.find((value) => value.partId === part.partId);
    return old && areJsonValuesEqual(old, part) ? old : part;
  });
export function reuseEntry(old: ChatEntry | undefined, next: ChatEntry): ChatEntry {
  if (old && areJsonValuesEqual(old, next)) return old;
  if (
    old?.transcript &&
    next.transcript &&
    areJsonValuesEqual(old.transcript.source, next.transcript.source)
  )
    return {
      ...next,
      transcript: {
        ...next.transcript,
        parts: reuseParts(old.transcript.parts, next.transcript.parts),
      },
    };
  return next;
}
/** Merge the server's ordered subsequences by durable entry ID, never by text/task. */
function mergeEntries(previous: ChatEntry[], page: ChatEntry[], direction: HistoryDirection) {
  if (new Set(page.map((entry) => entry.id)).size !== page.length)
    throw makeTranscriptFailure('History repeats an entry.');
  const result = previous.map((entry) =>
    reuseEntry(entry, page.find((value) => value.id === entry.id) ?? entry),
  );
  for (let i = 0; i < page.length; i++) {
    if (result.some((entry) => entry.id === page[i].id)) continue;
    const next = page.slice(i + 1).find((entry) => result.some((value) => value.id === entry.id));
    const prior = page[i - 1];
    let index = direction === 'earlier' ? result.length : 0;
    if (next) index = result.findIndex((entry) => entry.id === next.id);
    else if (prior && result.some((entry) => entry.id === prior.id))
      index = result.findIndex((entry) => entry.id === prior.id) + 1;
    result.splice(index, 0, page[i]);
  }
  let position = -1;
  for (const entry of page) {
    const next = result.findIndex((value) => value.id === entry.id);
    if (next <= position)
      throw makeTranscriptFailure('History order changed within a navigation window.');
    position = next;
  }
  return result;
}
/** Every stored transcript must name its own entry in this conversation. */
export function checkEntrySources(entries: ChatEntry[], target: ChatTarget) {
  for (const entry of entries)
    if (
      entry.transcript &&
      (entry.transcript.source.kind !== 'entry' ||
        entry.transcript.source.entryId !== entry.id ||
        !sameTarget(entry.transcript.source.target, target))
    )
      throw makeTranscriptFailure('Transcript entry belongs to another source.');
}

/** Checks a snapshot's authority: its conversation, entry sources and live run source. */
export function checkSnapshotSources(input: ChatSnapshot, target: ChatTarget) {
  if (!sameTarget(input.conversation.target, target))
    throw makeTranscriptFailure('Snapshot belongs to another conversation.');
  checkEntrySources(input.entries, target);
  const live = input.run?.transcript?.source;
  if (
    live &&
    (live.kind !== 'live' ||
      !sameTarget(live.target, target) ||
      live.submissionId !== input.run!.stop.submissionId ||
      live.taskId !== input.run!.stop.taskId)
  )
    throw makeTranscriptFailure('Live transcript does not match its run.');
}
/** Reuses retained values the snapshot repeats, so unchanged rows keep their identity. */
export function reuseSnapshot(
  input: ChatSnapshot,
  old: ChatSnapshot | undefined,
  history: TranscriptHistory,
): ChatSnapshot {
  const entries = input.entries.map((entry) =>
    reuseEntry(
      history.findRecord(entry.id) ?? old?.entries.find((value) => value.id === entry.id),
      entry,
    ),
  );
  let run = input.run;
  if (
    run?.transcript &&
    old?.run?.transcript &&
    areJsonValuesEqual(run.transcript.source, old.run.transcript.source)
  )
    run = {
      ...run,
      transcript: {
        ...run.transcript,
        parts: reuseParts(old.run.transcript.parts, run.transcript.parts),
      },
    };
  if (old?.run && areJsonValuesEqual(old.run, run)) run = old.run;
  return {
    ...input,
    entries,
    run,
    conversation:
      old && areJsonValuesEqual(old.conversation, input.conversation)
        ? old.conversation
        : input.conversation,
  };
}

/**
 * The retained history records, newest first and published oldest first. Earlier and later reads
 * extend them by a page; a jump replaces them, which bumps `dataset`.
 */
export class TranscriptHistory {
  records: ChatEntry[] = [];
  /**
   * The reader follows the live edge, so a snapshot that skips past the retained records replaces
   * them. A reader of history keeps their records and the gap shows as later history.
   */
  following: boolean;
  dataset = 0;
  private navigation?: Navigation;
  /** Legacy paging: each page or snapshot's oldest entry ID maps to its older-page cursor. */
  private olderCursors = new Map<string, string | null>();
  private olderEnd = true;
  private newerEnd = true;
  constructor(following: boolean) {
    this.following = following;
  }
  /** Bytes the bounds count for navigation state beyond the records themselves. */
  get navigationState() {
    return this.navigation;
  }
  findRecord(entryId: string | undefined) {
    return this.records.find((entry) => entry.id === entryId);
  }
  listRecords() {
    return this.records.slice().reverse();
  }
  hasEarlier() {
    return !this.olderEnd;
  }
  /** Whether newer stored history exists past the retained records. */
  hasLater() {
    return !this.newerEnd;
  }
  private replaceRecords(entries: ChatEntry[]) {
    if (this.records.length) this.dataset++;
    this.records = entries;
    this.navigation = undefined;
  }
  /**
   * Applies an accepted snapshot. Records that reach the live edge take its new entries; otherwise
   * a following reader jumps to the snapshot and a history reader keeps their records.
   */
  acceptSnapshot(entries: ChatEntry[], old: ChatSnapshot | undefined, input: ChatSnapshot) {
    const continuous = entries.some(
      (entry) =>
        old?.entries.some((previous) => previous.id === entry.id) &&
        this.records.some((cached) => cached.id === entry.id),
    );
    if (this.following && !continuous) {
      this.replaceRecords(entries);
      this.olderEnd = input.olderCursor === null;
      this.newerEnd = true;
    } else if (!old && !this.records.length) {
      this.records = entries;
      this.olderEnd = input.olderCursor === null;
      this.newerEnd = true;
    } else if (continuous && (this.following || this.newerEnd)) {
      this.records = mergeEntries(this.records, entries, 'later');
      this.newerEnd = true;
    } else {
      this.records = this.records.map((entry) =>
        reuseEntry(entry, entries.find((value) => value.id === entry.id) ?? entry),
      );
      if (old && old.transcriptBoundary !== input.transcriptBoundary) this.newerEnd = false;
    }
    this.rememberOlderCursor(entries, input.olderCursor);
  }
  /** The around-entry read that continues past the retained edge in `direction`. */
  findAroundRead(direction: HistoryDirection) {
    const edge = direction === 'earlier' ? this.records.at(-1) : this.records[0];
    const nav = this.navigation;
    const cursor = direction === 'earlier' ? nav?.olderCursor : nav?.newerCursor;
    const cursorEdge = direction === 'earlier' ? nav?.olderEdge : nav?.newerEdge;
    if (nav && cursor && edge?.id === cursorEdge) return { entryId: nav.entryId, cursor };
    if (edge) return { entryId: edge.id, cursor: undefined };
    return undefined;
  }
  /** Checks an around-entry reply against the read it answers before merging it. */
  checkAroundPage(
    page: AroundPage,
    target: ChatTarget,
    read: { entryId: string; cursor: string | undefined; direction: HistoryDirection },
  ) {
    const { entryId, cursor, direction } = read;
    if (
      !sameTarget(page.target, target) ||
      page.entryId !== entryId ||
      page.cursor !== (cursor ?? null) ||
      (cursor && this.navigation?.upperEntryId !== page.upperEntryId) ||
      (cursor && (direction === 'earlier' ? page.olderCursor : page.newerCursor) === cursor) ||
      (!cursor && !page.entries.some((entry) => entry.id === entryId))
    )
      throw makeTranscriptFailure('Around-entry reply does not match its navigation boundary.');
    checkEntrySources(page.entries, target);
  }
  /** Merges an around-entry page, or replaces the records with it for a jump. */
  applyAroundPage(
    page: AroundPage,
    direction: HistoryDirection,
    replace: boolean,
    newestLive: string | undefined,
  ) {
    if (replace) this.replaceRecords(mergeEntries([], page.entries, direction));
    else this.records = mergeEntries(this.records, page.entries, direction);
    this.navigation = {
      entryId: page.entryId,
      upperEntryId: page.upperEntryId,
      olderCursor: page.olderCursor,
      newerCursor: page.newerCursor,
      olderEdge: page.entries.at(-1)?.id,
      newerEdge: page.entries[0]?.id,
    };
    if (page.entries.at(-1)?.id === this.records.at(-1)?.id)
      this.olderEnd = page.olderCursor === null;
    // An earlier page extends the older end only; the newer end is where it was.
    if (replace || direction === 'later')
      this.newerEnd =
        page.newerCursor === null &&
        page.entries[0]?.id === this.records[0]?.id &&
        newestLive === this.records[0]?.id;
  }
  /** Merges a legacy older page read from `cursor`. */
  applyOlderPage(page: ChatOutput<'getChatHistory'>, cursor: string, target: ChatTarget) {
    if (page.olderCursor === cursor) throw makeTranscriptFailure('History cursor did not advance.');
    checkEntrySources(page.entries, target);
    this.records = mergeEntries(this.records, page.entries, 'earlier');
    this.rememberOlderCursor(page.entries, page.olderCursor);
    this.olderEnd = page.olderCursor === null;
  }
  /**
   * Legacy hosts read no newer pages: later history continues with the latest snapshot's entries,
   * or jumps to them when they don't overlap the retained records.
   */
  applyLatestEntries(entries: ChatEntry[]) {
    if (entries.some((entry) => this.findRecord(entry.id)))
      this.records = mergeEntries(this.records, entries, 'later');
    else this.replaceRecords(entries);
    this.newerEnd = true;
  }
  /**
   * Ends a page read, which held following off so no snapshot replaced the records it extends.
   * Records that reach the newest stored entry follow again if the reader was following or moved
   * later to them.
   */
  settleMove(direction: HistoryDirection, wasFollowing: boolean) {
    if (this.newerEnd && (wasFollowing || direction === 'later')) this.following = true;
  }
  /** Drops records and navigation before an explicit read of the latest snapshot. */
  resetToLatest() {
    this.replaceRecords([]);
    this.following = true;
  }
  /**
   * Picks a record to evict for the summary budget, from the end the reader is moving away from
   * and never the pinned anchor row. Returns undefined when nothing can be evicted.
   */
  evictRecord(direction: HistoryDirection, pinned: string | undefined) {
    const indices = this.records.map((_, index) => index);
    if (direction === 'later') indices.reverse();
    const index = indices.find((index) => pinned !== this.records[index].id);
    if (index === undefined) return undefined;
    const [removed] = this.records.splice(index, 1);
    if (direction === 'earlier') this.newerEnd = false;
    else this.olderEnd = false;
    return removed;
  }
  /**
   * Resumes legacy paging from the oldest cached checkpoint, so records evicted from the older end
   * are read again rather than skipped; mergeEntries drops the overlap by entry ID.
   */
  findOlderCursor(snapshotCursor: string | null | undefined) {
    for (let index = this.records.length - 1; index >= 0; index--) {
      const cursor = this.olderCursors.get(this.records[index].id);
      if (cursor !== undefined) return cursor;
    }
    // Empty records page from the snapshot's own older cursor.
    return this.records.length ? null : (snapshotCursor ?? null);
  }
  clear() {
    this.records = [];
  }
  private rememberOlderCursor(entries: ChatEntry[], cursor: string | null) {
    const oldest = entries.at(-1);
    if (oldest) this.olderCursors.set(oldest.id, cursor);
    const cached = new Set(this.records.map((entry) => entry.id));
    for (const id of this.olderCursors.keys()) if (!cached.has(id)) this.olderCursors.delete(id);
  }
}
