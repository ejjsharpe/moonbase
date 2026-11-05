import { maximumChatReplyBytes } from '@moonbase/contracts/chat';
import type {
  ChatClient,
  ChatTranscriptMatch,
  ChatCommand,
  ChatInput,
  ChatOutput,
  ChatEntry,
  ChatSnapshot,
  ChatTarget,
  ChatTranscriptSource,
  ChatTranscriptSelection,
  ChatTranscriptPart,
} from '@moonbase/contracts/chat';
import { decodeChatInput, decodeChatOutput } from '@moonbase/contracts/chat-schema';
import { normalizeApplicationError } from '../../runtime/effect-client.ts';
import { sameTarget } from './saved.ts';
import {
  decodeTranscriptView,
  type TranscriptViewMemory,
  type TranscriptView,
} from './view-memory.ts';
import {
  awaitTranscriptRead,
  checkTranscriptRead,
  countDecodedTranscriptBytes,
  areTranscriptValuesEqual as equal,
  iterateTranscriptSource,
  readTranscript,
  trackTranscriptCursor,
  countTranscriptBytes,
  makeTranscriptFailure,
  getTranscriptKey,
  type TranscriptChunk,
  type TranscriptRead,
  type TranscriptReadProgress,
} from './transcript-read.ts';

export const transcriptLimits = {
  displayedRows: 128,
  summaryRecords: 256,
  summaryBytes: 2 * 1024 * 1024,
  contentBytes: 8 * 1024 * 1024,
  findMatches: 256,
} as const;
type ReadStatus = 'partial' | 'loading' | 'complete' | 'error' | 'source-changed';
export type TranscriptContentState = {
  source: ChatTranscriptSource;
  selection: ChatTranscriptSelection;
  chunks: TranscriptChunk[];
  loadedBytes: number;
  loadedText: number;
  retainedFrom: number;
  nextCursor: string | null;
  status: ReadStatus;
  error: string | null;
};
export type TranscriptManifestState = {
  source: ChatTranscriptSource;
  parts: ChatTranscriptPart[];
  nextCursor: string | null;
  omittedParts: number;
  status: ReadStatus;
  error: string | null;
};
export type TranscriptState = {
  capabilities: {
    transcript: 'unknown' | 'available' | 'legacy';
    find: 'available' | 'unavailable';
  };
  find: TranscriptFindState;
  observation: 'inactive' | 'local' | 'streaming' | 'legacy' | 'reconnecting' | 'failed';
  entries: ChatEntry[];
  earlier: boolean;
  later: boolean;
  atLatest: boolean;
  loading: boolean;
  error: string | null;
  view: TranscriptView;
  manifest: TranscriptManifestState | null;
  content: TranscriptContentState[];
  retained: { summaries: number; summaryBytes: number; contentBytes: number };
};
export type TranscriptFindState = {
  open: boolean;
  revealing: boolean;
  query: string;
  status: 'idle' | 'searching' | 'complete' | 'error';
  error: string | null;
  matches: ChatTranscriptMatch[];
  retainedFrom: number;
  count: number;
  active: ChatTranscriptMatch | null;
  activeIndex: number | null;
  upperEntryId: string | null;
  progress: { entries: number; bytes: number };
  refreshAvailable: boolean;
};
const emptyFind = (): TranscriptFindState => ({
  open: false,
  revealing: false,
  query: '',
  status: 'idle',
  error: null,
  matches: [],
  retainedFrom: 0,
  count: 0,
  active: null,
  activeIndex: null,
  upperEntryId: null,
  progress: { entries: 0, bytes: 0 },
  refreshAvailable: false,
});
export function makeEmptyTranscriptState(): TranscriptState {
  return {
    capabilities: { transcript: 'unknown', find: 'unavailable' },
    find: emptyFind(),
    observation: 'inactive',
    entries: [],
    earlier: false,
    later: false,
    atLatest: true,
    loading: false,
    error: null,
    view: { anchor: null, expanded: [] },
    manifest: null,
    content: [],
    retained: { summaries: 0, summaryBytes: 0, contentBytes: 0 },
  };
}
const reuseParts = (previous: ChatTranscriptPart[], next: ChatTranscriptPart[]) =>
  next.map((part) => {
    const old = previous.find((value) => value.partId === part.partId);
    return old && equal(old, part) ? old : part;
  });
function reuseEntry(old: ChatEntry | undefined, next: ChatEntry): ChatEntry {
  if (old && equal(old, next)) return old;
  if (old?.transcript && next.transcript && equal(old.transcript.source, next.transcript.source))
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
function mergeEntries(previous: ChatEntry[], page: ChatEntry[], direction: 'earlier' | 'later') {
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

type TranscriptDependencies = {
  chat: ChatClient;
  target: ChatTarget;
  backend: string;
  memory: TranscriptViewMemory;
  capable: boolean;
  streaming: boolean;
  findCapable: boolean;
  local: boolean;
  publish: (state: TranscriptState, snapshot?: ChatSnapshot) => void;
};
type Navigation = {
  entryId: string;
  upperEntryId: string;
  olderCursor: string | null;
  newerCursor: string | null;
  olderEdge: string | undefined;
  newerEdge: string | undefined;
};
/** One selected read owner, subordinate to the existing selection scope. */
export class TranscriptOwner {
  private state = makeEmptyTranscriptState();
  private published = this.state;
  private selectedEntry?: ChatEntry;
  private records: ChatEntry[] = []; // newest first; public window is oldest first
  private start = 0;
  private snapshot?: ChatSnapshot;
  private navigation?: Navigation;
  private latestCursor: string | null = null;
  private olderEnd = true;
  private newerEnd = true;
  private following = true;
  private restorePending = true;
  private restoringView = false;
  private alive = true;
  private failed = false;
  private lifetime = new AbortController();
  private pending = new Map<
    Promise<unknown>,
    { abort: AbortController; source?: ChatTranscriptSource }
  >();
  private jobs = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  private contents = new Map<string, TranscriptContentState>();
  private manifestAdvance = trackTranscriptCursor();
  private findGeneration = 0;
  private findAbort = new AbortController();
  private findReveal = new AbortController();
  private findStart: string | null = null;
  private findUpper: string | null | undefined;
  private findProgress = { entries: 0, bytes: 0 };
  private findAdvance = trackTranscriptCursor();
  private dependencies: TranscriptDependencies;
  constructor(dependencies: TranscriptDependencies) {
    this.dependencies = dependencies;
    this.state.view = dependencies.memory.get(dependencies.backend, dependencies.target);
    this.following = !this.state.view.anchor || !!this.state.view.anchor.source;
    this.state.capabilities = {
      transcript: dependencies.capable ? 'available' : 'legacy',
      find: dependencies.findCapable && dependencies.capable ? 'available' : 'unavailable',
    };
  }
  getSnapshot() {
    return this.state;
  }
  private current(source?: ChatTranscriptSource) {
    return (
      this.alive &&
      !this.failed &&
      (!source ||
        (sameTarget(source.target, this.dependencies.target) &&
          (source.kind === 'entry' ||
            (this.snapshot?.observationStatus !== 'reconnecting' &&
              equal(this.snapshot?.run?.transcript?.source, source)))))
    );
  }
  private assertCurrent(source?: ChatTranscriptSource) {
    if (!this.current(source))
      throw makeTranscriptFailure(
        'Transcript source changed or is stale.',
        this.alive ? 'Conflict' : 'Cancelled',
      );
  }
  private async command<K extends ChatCommand>(
    operation: K,
    input: ChatInput<K>,
    signal?: AbortSignal,
    settlements?: Set<Promise<unknown>>,
  ): Promise<ChatOutput<K>> {
    this.assertCurrent();
    const abort = new AbortController();
    // readTranscript owns transcript content input/reply decoding, cloning and size bounds.
    const transcript = operation === 'getChatTranscriptContent';
    const source = transcript ? (input as ChatInput<'getChatTranscriptContent'>).source : undefined;
    this.assertCurrent(source);
    const combined = AbortSignal.any([
      ...(signal ? [signal] : []),
      this.lifetime.signal,
      abort.signal,
    ]);
    const pending = this.dependencies.chat.command(
      operation,
      transcript ? input : structuredClone(decodeChatInput(operation, input)),
      { signal: combined },
    );
    this.pending.set(pending, { abort, source });
    settlements?.add(pending);
    const settle = () => {
      this.pending.delete(pending);
      settlements?.delete(pending);
    };
    void pending.then(settle, settle);
    const result = await awaitTranscriptRead(pending, combined);
    this.assertCurrent();
    if (signal?.aborted || abort.signal.aborted)
      throw makeTranscriptFailure('Transcript read cancelled.', 'Cancelled');
    if (transcript) return result;
    if (countTranscriptBytes(result) > maximumChatReplyBytes)
      throw makeTranscriptFailure('Transcript reply exceeds its byte bound.');
    return decodeChatOutput(operation, result);
  }
  private validateEntries(entries: ChatEntry[]) {
    for (const entry of entries)
      if (
        entry.transcript &&
        (entry.transcript.source.kind !== 'entry' ||
          entry.transcript.source.entryId !== entry.id ||
          !sameTarget(entry.transcript.source.target, this.dependencies.target))
      )
        throw makeTranscriptFailure('Transcript entry belongs to another source.');
  }
  private read = (
    input: ChatInput<'getChatTranscriptContent'>,
    options: { signal?: AbortSignal },
  ) => this.command('getChatTranscriptContent', input, options.signal);
  private summaryUsage() {
    const entries = [
      ...new Map(
        [
          ...(this.snapshot?.entries ?? []),
          ...(this.selectedEntry ? [this.selectedEntry] : []),
          ...this.records,
        ].map((entry) => [entry.id, entry]),
      ).values(),
    ];
    return {
      summaries: entries.length + (this.state.manifest?.parts.length ?? 0),
      summaryBytes: countTranscriptBytes({
        entries,
        manifest: this.state.manifest,
        navigation: this.navigation,
        view: this.state.view,
      }),
    };
  }
  private contentUsage() {
    return countTranscriptBytes([...this.contents.values()]);
  }
  private enforceBounds(direction: 'earlier' | 'later') {
    let usage = this.summaryUsage();
    while (
      usage.summaries > transcriptLimits.summaryRecords ||
      usage.summaryBytes > transcriptLimits.summaryBytes
    ) {
      if (this.state.manifest?.parts.length) {
        this.state = {
          ...this.state,
          manifest: {
            ...this.state.manifest,
            parts: this.state.manifest.parts.slice(1),
            omittedParts: this.state.manifest.omittedParts + 1,
          },
        };
      } else {
        const pinned = this.state.view.anchor?.entryId;
        const indices = this.records.map((_, index) => index);
        if (direction === 'later') indices.reverse();
        const index =
          indices.find(
            (index) =>
              pinned !== this.records[index].id &&
              (index < this.start || index >= this.start + transcriptLimits.displayedRows),
          ) ?? indices.find((index) => pinned !== this.records[index].id);
        if (index === undefined) break;
        this.records.splice(index, 1);
        if (index < this.start) this.start--;
        if (direction === 'earlier') this.newerEnd = false;
        else this.olderEnd = false;
      }
      usage = this.summaryUsage();
    }
    while (this.contents.size > 128) this.contents.delete(this.contents.keys().next().value!);
    while (this.contentUsage() > transcriptLimits.contentBytes) {
      const item = [...this.contents].find(([, value]) => value.chunks.length);
      if (item) {
        const [key, value] = item;
        const chunks = value.chunks.slice(1);
        this.contents.set(key, {
          ...value,
          chunks,
          retainedFrom: chunks[0]?.offset ?? value.loadedBytes,
        });
      } else this.contents.delete(this.contents.keys().next().value!);
    }
    this.start = Math.max(
      0,
      Math.min(this.start, Math.max(0, this.records.length - transcriptLimits.displayedRows)),
    );
  }
  private publish(
    notify = true,
    direction: 'earlier' | 'later' = this.following ? 'later' : 'earlier',
  ) {
    if (!this.alive) return;
    this.enforceBounds(direction);
    const entries = this.records
      .slice(this.start, this.start + transcriptLimits.displayedRows)
      .reverse();
    const previous = this.state.entries;
    this.state = {
      ...this.state,
      entries:
        entries.length === previous.length &&
        entries.every((entry, index) => entry === previous[index])
          ? previous
          : entries,
      earlier: this.start + entries.length < this.records.length || !this.olderEnd,
      later: this.start > 0 || !this.newerEnd,
      atLatest: this.following,
      content: [...this.contents.values()],
      retained: { ...this.summaryUsage(), contentBytes: this.contentUsage() },
    };
    const changed = !equal(this.published, this.state);
    if (!changed) this.state = this.published;
    else this.published = this.state;
    if (notify && changed) this.dependencies.publish(this.state, this.snapshot);
  }
  accept(raw: ChatSnapshot): ChatSnapshot {
    if (countTranscriptBytes(raw) > maximumChatReplyBytes)
      throw makeTranscriptFailure('Snapshot exceeds its byte bound.');
    const input = decodeChatOutput('getChat', raw);
    if (!sameTarget(input.conversation.target, this.dependencies.target))
      throw makeTranscriptFailure('Snapshot belongs to another conversation.');
    this.validateEntries(input.entries);
    if (
      input.run?.transcript &&
      (input.run.transcript.source.kind !== 'live' ||
        !sameTarget(input.run.transcript.source.target, this.dependencies.target) ||
        input.run.transcript.source.submissionId !== input.run.stop.submissionId ||
        input.run.transcript.source.taskId !== input.run.stop.taskId)
    )
      throw makeTranscriptFailure('Live transcript does not match its run.');
    const old = this.snapshot;
    const entries = input.entries.map((entry) =>
      reuseEntry(
        this.records.find((value) => value.id === entry.id) ??
          old?.entries.find((value) => value.id === entry.id),
        entry,
      ),
    );
    let run = input.run;
    if (
      run?.transcript &&
      old?.run?.transcript &&
      equal(run.transcript.source, old.run.transcript.source)
    )
      run = {
        ...run,
        transcript: {
          ...run.transcript,
          parts: reuseParts(old.run.transcript.parts, run.transcript.parts),
        },
      };
    if (old?.run && equal(old.run, run)) run = old.run;
    const next = {
      ...input,
      entries,
      run,
      conversation:
        old && equal(old.conversation, input.conversation) ? old.conversation : input.conversation,
    };
    this.snapshot = old && equal(old, next) ? old : next;
    this.failed = false;
    let observation: TranscriptState['observation'] = this.dependencies.streaming
      ? 'streaming'
      : 'legacy';
    if (this.dependencies.local) observation = 'local';
    if (input.observationStatus === 'reconnecting') observation = 'reconnecting';
    this.state = {
      ...this.state,
      observation,
      find: {
        ...this.state.find,
        refreshAvailable:
          this.findUpper !== undefined && this.findUpper !== input.transcriptBoundary,
      },
    };
    if (input.observationStatus === 'reconnecting' && this.state.find.query) {
      this.cancelFind();
      this.state = {
        ...this.state,
        find: {
          ...this.state.find,
          status: 'error',
          error: 'Connection changed. Refresh Find after reconnecting.',
        },
      };
    }
    this.latestCursor = input.olderCursor;
    if (this.following) {
      const continuous = entries.some(
        (entry) =>
          old?.entries.some((previous) => previous.id === entry.id) &&
          this.records.some((cached) => cached.id === entry.id),
      );
      if (!continuous) {
        this.records = entries;
        this.navigation = undefined;
      } else this.records = mergeEntries(this.records, entries, 'later');
      // A coherent new boundary replaces the live edge; historical navigation stays independent.
      this.start = 0;
      this.newerEnd = true;
      if (!this.navigation) this.olderEnd = input.olderCursor === null;
    } else {
      this.records = (old ? this.records : entries).map((entry) =>
        reuseEntry(entry, entries.find((value) => value.id === entry.id) ?? entry),
      );
      if (!old) {
        this.olderEnd = input.olderCursor === null;
        this.newerEnd = true;
      } else if (old.transcriptBoundary !== input.transcriptBoundary) this.newerEnd = false;
    }
    for (const read of this.pending.values())
      if (read.source?.kind === 'live' && !this.current(read.source)) read.abort.abort();
    for (const [key, content] of this.contents) {
      const transcript =
        content.source.kind === 'live'
          ? run?.transcript
          : entries.find(
              (entry) =>
                entry.id === (content.source.kind === 'entry' ? content.source.entryId : undefined),
            )?.transcript;
      const part = transcript?.parts.find((part) => part.partId === content.selection.partId);
      if (
        !this.current(content.source) ||
        (part &&
          (part.bytes !== content.selection.bytes ||
            part.revision !== content.selection.revision ||
            part.availability !== 'available'))
      ) {
        this.contents.set(key, {
          ...content,
          status: 'source-changed',
          error: 'Transcript source changed or is stale. Reload the selected part.',
        });
        this.jobs.get(key)?.abort.abort();
      }
    }
    const manifest = this.state.manifest;
    if (manifest) {
      let changed = !this.current(manifest.source);
      if (manifest.source.kind === 'live')
        changed ||= !!old?.run?.transcript && !equal(old.run.transcript, run?.transcript);
      else {
        const entryId = manifest.source.entryId;
        const previous = old?.entries.find((entry) => entry.id === entryId)?.transcript;
        const next = entries.find((entry) => entry.id === entryId)?.transcript;
        changed ||= !!previous && !!next && !equal(previous, next);
      }
      if (changed) {
        this.state = {
          ...this.state,
          manifest: {
            ...manifest,
            status: 'source-changed',
            error: 'Transcript source changed or is stale. Reload the manifest.',
          },
        };
        this.jobs.get('manifest')?.abort.abort();
      }
    }
    this.publish(false);
    return this.snapshot;
  }
  fail(error: unknown) {
    this.cancelFind();
    this.failed = true;
    for (const job of this.jobs.values()) job.abort.abort();
    for (const read of this.pending.values()) read.abort.abort();
    const failure = normalizeApplicationError(error).message;
    for (const [key, content] of this.contents)
      if (content.source.kind === 'live' || content.status === 'loading')
        this.contents.set(key, {
          ...content,
          status: content.source.kind === 'live' ? 'source-changed' : 'error',
          error: failure,
        });
    const manifest = this.state.manifest;
    this.state = {
      ...this.state,
      observation: 'failed',
      find: this.state.find.query
        ? { ...this.state.find, status: 'error', error: failure }
        : this.state.find,
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
    this.publish();
  }
  private cancelFind() {
    this.findGeneration++;
    this.findAbort.abort();
    this.findReveal.abort();
    this.state = { ...this.state, find: { ...this.state.find, revealing: false } };
  }
  openFind() {
    this.state = { ...this.state, find: { ...this.state.find, open: true } };
    this.publish();
  }
  cancelFindReveal() {
    this.findReveal.abort();
    if (!this.state.find.revealing) return;
    this.state = { ...this.state, find: { ...this.state.find, revealing: false } };
    this.publish();
  }
  closeFind() {
    this.cancelFind();
    this.state = { ...this.state, find: emptyFind() };
    this.publish();
  }
  private async readFind(
    query: string,
    cursor: string | null,
    signal: AbortSignal,
    progress: { entries: number; bytes: number },
    advance: ReturnType<typeof trackTranscriptCursor>,
    previous?: ChatTranscriptMatch,
  ) {
    const page = await this.command(
      'findChatTranscript',
      { target: this.dependencies.target, query, ...(cursor ? { cursor } : {}) },
      signal,
    );
    checkTranscriptRead(signal, () => this.current());
    if (
      !sameTarget(page.target, this.dependencies.target) ||
      page.query !== query ||
      page.cursor !== cursor ||
      (this.findStart !== null && page.startCursor !== this.findStart) ||
      (this.findUpper !== undefined && page.upperEntryId !== this.findUpper) ||
      page.progress.entries < progress.entries ||
      page.progress.bytes < progress.bytes ||
      (page.nextCursor !== null &&
        page.progress.entries === progress.entries &&
        page.progress.bytes === progress.bytes)
    )
      throw makeTranscriptFailure(
        'Find reply does not match the query or advance its fixed boundary.',
      );
    const expression = new RegExp(
      '^(?:' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')',
      'iu',
    );
    let last = previous;
    const seen = new Set<string>();
    for (const match of page.matches) {
      const key = getTranscriptKey([match.source, match.partId, match.start, match.end]);
      if (
        seen.has(key) ||
        (last &&
          equal(last.source, match.source) &&
          last.partId === match.partId &&
          match.start < last.end) ||
        (last &&
          /^\d+$/.test(last.source.entryId) &&
          /^\d+$/.test(match.source.entryId) &&
          Number(match.source.entryId) < Number(last.source.entryId))
      )
        throw makeTranscriptFailure('Find repeats or reverses an original-text match.');
      seen.add(key);
      last = match;
      const start = match.start - match.snippet.start,
        end = match.end - match.snippet.start;
      if (
        !sameTarget(match.source.target, this.dependencies.target) ||
        page.upperEntryId === null ||
        (/^\d+$/.test(match.source.entryId) &&
          /^\d+$/.test(page.upperEntryId) &&
          Number(match.source.entryId) > Number(page.upperEntryId)) ||
        !match.snippet.text.slice(0, start).isWellFormed() ||
        !match.snippet.text.slice(end).isWellFormed() ||
        expression.exec(match.snippet.text.slice(start, end))?.[0].length !== end - start
      )
        throw makeTranscriptFailure('Find returned an invalid original-text match.');
    }
    advance(cursor, page.nextCursor);
    return page;
  }
  findTranscript(query: string): Promise<void> {
    this.cancelFind();
    this.findAbort = new AbortController();
    this.findReveal = new AbortController();
    this.findStart = null;
    this.findUpper = undefined;
    this.findProgress = { entries: 0, bytes: 0 };
    this.findAdvance = trackTranscriptCursor();
    const generation = this.findGeneration,
      signal = this.findAbort.signal;
    const current = () => generation === this.findGeneration && this.current() && !signal.aborted;
    this.state = {
      ...this.state,
      find: {
        ...emptyFind(),
        open: true,
        query,
        revealing: !!query,
        status: query ? 'searching' : 'idle',
      },
    };
    this.publish();
    if (!query || generation !== this.findGeneration || signal.aborted) return Promise.resolve();
    if (!current()) {
      if (this.alive) {
        this.state = {
          ...this.state,
          find: {
            ...this.state.find,
            status: 'error',
            revealing: false,
            error: 'Reconnect or reopen this conversation before using Find.',
          },
        };
        this.publish();
      }
      return Promise.resolve();
    }
    return (async () => {
      try {
        decodeChatInput('findChatTranscript', { target: this.dependencies.target, query });
        if (this.state.capabilities.find !== 'available')
          throw makeTranscriptFailure(
            'Upgrade this host for complete conversation Find.',
            'Unavailable',
          );
        let cursor: string | null = null;
        let last: ChatTranscriptMatch | undefined;
        do {
          const page = await this.readFind(
            query,
            cursor,
            signal,
            this.findProgress,
            this.findAdvance,
            last,
          );
          checkTranscriptRead(signal, current);
          last = page.matches.at(-1) ?? last;
          this.findStart = page.startCursor;
          this.findUpper = page.upperEntryId;
          this.findProgress = page.progress;
          const previous = this.state.find;
          const all = [...previous.matches, ...page.matches];
          const matches = all.slice(-transcriptLimits.findMatches);
          const count = previous.count + page.matches.length;
          this.state = {
            ...this.state,
            find: {
              ...previous,
              matches,
              retainedFrom: count - matches.length,
              count,
              progress: page.progress,
              upperEntryId: page.upperEntryId,
              refreshAvailable: page.upperEntryId !== this.snapshot?.transcriptBoundary,
              status: page.nextCursor ? 'searching' : 'complete',
            },
          };
          const first = previous.active === null && page.matches[0];
          if (first)
            this.state.find = {
              ...this.state.find,
              active: first,
              activeIndex: previous.count,
              revealing: previous.revealing,
            };
          this.publish();
          if (first && current() && this.state.find.revealing)
            void this.revealFindMatch(first, generation);
          checkTranscriptRead(signal, current);
          cursor = page.nextCursor;
          if (cursor) await new Promise<void>((resolve) => setTimeout(resolve, 0));
        } while (cursor);
      } catch (error) {
        if (!current()) return;
        this.state = {
          ...this.state,
          find: {
            ...this.state.find,
            status: 'error',
            error: normalizeApplicationError(error).message,
          },
        };
        this.publish();
      }
    })();
  }
  private async revealFindMatch(
    match: ChatTranscriptMatch,
    generation: number,
    capturedSignal?: AbortSignal,
  ) {
    if (
      !this.current() ||
      generation !== this.findGeneration ||
      !this.state.find.revealing ||
      !equal(this.state.find.active, match)
    )
      return;
    if (!capturedSignal) {
      this.findReveal.abort();
      this.findReveal = new AbortController();
    }
    const signal =
      capturedSignal ?? AbortSignal.any([this.findAbort.signal, this.findReveal.signal]);
    this.jobs.get('history')?.abort.abort();
    this.jobs.delete('history');
    this.restoringView = false;
    this.following = false;
    this.restorePending = false;
    try {
      await this.readAround(match.source.entryId, undefined, 'earlier', signal, true);
      checkTranscriptRead(signal, () => generation === this.findGeneration && this.current());
      this.setView({
        anchor: { entryId: match.source.entryId, partId: match.partId, offset: 0 },
        expanded: this.state.view.expanded,
      });
    } catch (error) {
      if (signal.aborted || generation !== this.findGeneration || !this.current()) return;
      this.state = {
        ...this.state,
        find: { ...this.state.find, error: normalizeApplicationError(error).message },
      };
      this.publish();
    }
  }
  async moveFind(direction: 'next' | 'previous') {
    if (!this.current() || !this.state.find.query) return;
    const previous = this.state.find;
    const index = Math.max(0, (previous.activeIndex ?? -1) + (direction === 'next' ? 1 : -1));
    if (index >= previous.count) return;
    const generation = this.findGeneration;
    this.findReveal.abort();
    this.findReveal = new AbortController();
    const signal = AbortSignal.any([this.findAbort.signal, this.findReveal.signal]);
    const current = () => generation === this.findGeneration && this.current() && !signal.aborted;
    try {
      let match: ChatTranscriptMatch | undefined = previous.matches[index - previous.retainedFrom];
      if (!match && previous.activeIndex === index) match = previous.active ?? undefined;
      if (!match) {
        let cursor = this.findStart,
          offset = 0,
          progress = { entries: 0, bytes: 0 };
        const advance = trackTranscriptCursor();
        let last: ChatTranscriptMatch | undefined;
        if (!cursor) throw makeTranscriptFailure('Find must be refreshed before replay.');
        do {
          const page = await this.readFind(previous.query, cursor, signal, progress, advance, last);
          last = page.matches.at(-1) ?? last;
          checkTranscriptRead(signal, current);
          progress = page.progress;
          if (index < offset + page.matches.length) {
            match = page.matches[index - offset];
            break;
          }
          offset += page.matches.length;
          cursor = page.nextCursor;
        } while (cursor);
      }
      checkTranscriptRead(signal, current);
      if (!match)
        throw makeTranscriptFailure('Saved Find match is no longer available.', 'Conflict');
      this.state = {
        ...this.state,
        find: {
          ...this.state.find,
          active: match,
          activeIndex: index,
          error: null,
          revealing: true,
        },
      };
      this.publish();
      if (current()) await this.revealFindMatch(match, generation, signal);
    } catch (error) {
      if (!current()) return;
      this.state = {
        ...this.state,
        find: { ...this.state.find, error: normalizeApplicationError(error).message },
      };
      this.publish();
    }
  }
  private getLiveEvidence(selection?: ChatTranscriptSelection) {
    const transcript = this.snapshot?.run?.transcript;
    const part = selection && transcript?.parts.find((part) => part.partId === selection.partId);
    return part
      ? {
          partId: part.partId,
          bytes: part.bytes,
          revision: part.revision,
          availability: part.availability,
        }
      : transcript;
  }
  restore() {
    if (!this.restorePending) return Promise.resolve();
    this.restorePending = false;
    const anchor = this.state.view.anchor;
    // View memory is a location hint; only content reads need source proofs.
    if (!anchor || anchor.source) return Promise.resolve();
    this.restoringView = true;
    return this.around(anchor.entryId, false).finally(() => {
      this.restoringView = false;
    });
  }
  private cancelViewRestore() {
    if (!this.restoringView) return;
    this.restoringView = false;
    this.jobs.get('history')?.abort.abort();
    this.jobs.delete('history');
    this.state = { ...this.state, loading: false };
  }
  private getFindSignal(source: ChatTranscriptSource) {
    return this.state.find.revealing && equal(this.state.find.active?.source, source)
      ? AbortSignal.any([this.findAbort.signal, this.findReveal.signal])
      : undefined;
  }
  private run(name: string, work: (signal: AbortSignal) => Promise<void>, signal?: AbortSignal) {
    if (!this.current()) return Promise.resolve();
    const old = this.jobs.get(name);
    if (old) return old.promise;
    const job = { abort: new AbortController(), promise: Promise.resolve() };
    this.jobs.set(name, job);
    const cancel = () => job.abort.abort();
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    // Admit/capture before publishing: subscribers may change selection synchronously.
    job.promise = Promise.resolve()
      .then(() => {
        if (job.abort.signal.aborted) return;
        this.assertCurrent();
        return work(job.abort.signal);
      })
      .catch((error) => {
        if (!this.current() || job.abort.signal.aborted || this.jobs.get(name) !== job) return;
        this.state = { ...this.state, error: normalizeApplicationError(error).message };
      })
      .finally(() => {
        signal?.removeEventListener('abort', cancel);
        if (this.jobs.get(name) !== job) return;
        this.jobs.delete(name);
        if (job.abort.signal.aborted) {
          const content = this.contents.get(name);
          if (content?.status === 'loading')
            this.contents.set(name, { ...content, status: 'partial' });
          if (name === 'manifest' && this.state.manifest?.status === 'loading')
            this.state = { ...this.state, manifest: { ...this.state.manifest, status: 'partial' } };
        }
        if (this.alive) {
          this.state = { ...this.state, loading: this.jobs.has('history') };
          this.publish();
        }
      });
    this.state = {
      ...this.state,
      error: null,
      loading: name === 'history' || this.state.loading,
    };
    this.publish();
    return job.promise;
  }
  earlier = () => this.move('earlier');
  later = () => this.move('later');
  private move(direction: 'earlier' | 'later') {
    this.cancelFindReveal();
    const pending = this.jobs.get('history');
    if (pending && !this.restoringView) return pending.promise;
    if (!this.current() || !this.state[direction]) return pending?.promise ?? Promise.resolve();
    this.cancelViewRestore();
    this.restorePending = false;
    // Freeze the reading window before loading can notify a subscriber.
    this.following = false;
    return this.run('history', async (signal) => {
      const previous = this.start;
      if (
        direction === 'earlier' &&
        this.start + transcriptLimits.displayedRows < this.records.length
      ) {
        this.start = Math.min(
          this.records.length - transcriptLimits.displayedRows,
          this.start + 32,
        );
      } else if (direction === 'later' && this.start > 0) this.start = Math.max(0, this.start - 32);
      else if (this.dependencies.capable && this.records.length) {
        const edge = direction === 'earlier' ? this.state.entries[0] : this.state.entries.at(-1);
        const nav = this.navigation;
        const cursor = direction === 'earlier' ? nav?.olderCursor : nav?.newerCursor;
        const cursorEdge = direction === 'earlier' ? nav?.olderEdge : nav?.newerEdge;
        if (nav && cursor && edge?.id === cursorEdge)
          await this.readAround(nav.entryId, cursor, direction, signal);
        else if (edge) await this.readAround(edge.id, undefined, direction, signal);
      } else if (direction === 'earlier' && this.latestCursor) {
        const cursor = this.latestCursor;
        const page = await this.command(
          'getChatHistory',
          { target: this.dependencies.target, cursor },
          signal,
        );
        checkTranscriptRead(signal, () => this.current());
        if (page.olderCursor === cursor)
          throw makeTranscriptFailure('History cursor did not advance.');
        this.validateEntries(page.entries);
        this.records = mergeEntries(this.records, page.entries, 'earlier');
        this.latestCursor = page.olderCursor;
        this.olderEnd = page.olderCursor === null;
        this.start = Math.max(0, this.records.length - transcriptLimits.displayedRows);
      }
      checkTranscriptRead(signal, () => this.current());
      if (direction === 'later' && this.start === 0 && this.newerEnd) this.following = true;
      if (this.start !== previous || this.state.entries.length) this.rememberWindow(direction);
      this.publish(true, direction);
    });
  }
  private async readAround(
    entryId: string,
    cursor: string | undefined,
    direction: 'earlier' | 'later',
    signal: AbortSignal,
    replace = false,
  ) {
    if (entryId === 'live')
      throw makeTranscriptFailure('Use an exact live-part anchor instead of a synthetic entry.');
    const page = await this.command(
      'getChatHistoryAround',
      { target: this.dependencies.target, entryId, ...(cursor ? { cursor } : {}) },
      signal,
    );
    checkTranscriptRead(signal, () => this.current());
    if (
      !sameTarget(page.target, this.dependencies.target) ||
      page.entryId !== entryId ||
      page.cursor !== (cursor ?? null) ||
      (cursor && this.navigation?.upperEntryId !== page.upperEntryId) ||
      (cursor && (direction === 'earlier' ? page.olderCursor : page.newerCursor) === cursor) ||
      (!cursor && !page.entries.some((entry) => entry.id === entryId))
    )
      throw makeTranscriptFailure('Around-entry reply does not match its navigation boundary.');
    this.validateEntries(page.entries);
    this.records = mergeEntries(replace ? [] : this.records, page.entries, direction);
    this.navigation = {
      entryId,
      upperEntryId: page.upperEntryId,
      olderCursor: page.olderCursor,
      newerCursor: page.newerCursor,
      olderEdge: page.entries.at(-1)?.id,
      newerEdge: page.entries[0]?.id,
    };
    if (page.entries.at(-1)?.id === this.records.at(-1)?.id)
      this.olderEnd = page.olderCursor === null;
    this.newerEnd =
      page.newerCursor === null &&
      page.entries[0]?.id === this.records[0]?.id &&
      this.snapshot?.entries[0]?.id === this.records[0]?.id;
    this.start =
      direction === 'earlier'
        ? Math.max(0, this.records.length - transcriptLimits.displayedRows)
        : 0;
  }
  around(entryId: string, resetView = true) {
    if (resetView) {
      this.restorePending = false;
      this.restoringView = false;
      this.cancelFindReveal();
    }
    this.following = false;
    this.jobs.get('history')?.abort.abort();
    this.jobs.delete('history');
    return this.run('history', async (signal) => {
      if (!this.dependencies.capable)
        throw makeTranscriptFailure(
          'This host requires an upgrade for transcript navigation.',
          'Unavailable',
        );
      await this.readAround(entryId, undefined, 'earlier', signal, true);
      checkTranscriptRead(signal, () => this.current());
      if (resetView)
        this.setView({
          anchor: { entryId, offset: 0 },
          expanded: this.state.view.anchor?.source ? [] : this.state.view.expanded,
        });
    });
  }
  latest = () => {
    this.restoringView = false;
    this.cancelFindReveal();
    this.restorePending = false;
    this.jobs.get('history')?.abort.abort();
    this.jobs.delete('history');
    return this.run('history', async (signal) => {
      const previous = this.snapshot;
      const snapshot = await this.command('getChat', { target: this.dependencies.target }, signal);
      checkTranscriptRead(signal, () => this.current());
      this.records = [];
      this.start = 0;
      this.navigation = undefined;
      this.following = true;
      this.state = {
        ...this.state,
        view: {
          anchor: null,
          expanded: this.state.view.anchor?.source ? [] : this.state.view.expanded,
        },
      };
      this.dependencies.memory.set(
        this.dependencies.backend,
        this.dependencies.target,
        this.state.view,
      );
      // A watch received during this explicit read wins its coherent live boundary.
      this.accept(this.snapshot !== previous && this.snapshot ? this.snapshot : snapshot);
    });
  };
  private rememberWindow(direction: 'earlier' | 'later') {
    const entry = direction === 'earlier' ? this.records.at(-1) : this.records[this.start];
    this.rememberView({
      expanded: this.state.view.anchor?.source ? [] : this.state.view.expanded,
      anchor: this.following || !entry ? null : { entryId: entry.id, offset: 0 },
    });
  }
  private rememberView(view: TranscriptView) {
    this.dependencies.memory.set(this.dependencies.backend, this.dependencies.target, view);
    const captured = this.dependencies.memory.get(
      this.dependencies.backend,
      this.dependencies.target,
    );
    this.state = { ...this.state, view: captured };
  }
  setView(view: TranscriptView) {
    if (!this.alive) return;
    const captured = decodeTranscriptView(
      this.dependencies.backend,
      this.dependencies.target,
      view,
    );
    this.cancelViewRestore();
    this.restorePending = false;
    this.rememberView(captured);
    if (captured.anchor) this.following = !!captured.anchor.source;
    this.publish();
  }
  loadManifest(source: ChatTranscriptSource, restart = false) {
    const captured = structuredClone(
      decodeChatInput('getChatTranscriptContent', { source }).source,
    );
    const old = this.state.manifest;
    if (restart || !equal(old?.source, captured)) {
      this.jobs.get('manifest')?.abort.abort();
      this.jobs.delete('manifest');
      this.manifestAdvance = trackTranscriptCursor();
      this.state = {
        ...this.state,
        manifest: {
          source: captured,
          parts: [],
          nextCursor: null,
          omittedParts: 0,
          status: 'partial',
          error: null,
        },
      };
    }
    const manifest = this.state.manifest!;
    if (manifest.status === 'complete' || manifest.status === 'source-changed')
      return Promise.resolve();
    return this.run(
      'manifest',
      async (signal) => {
        if (!this.dependencies.capable)
          throw makeTranscriptFailure(
            'This host requires an upgrade for transcript content.',
            'Unavailable',
          );
        this.state = { ...this.state, manifest: { ...manifest, status: 'loading', error: null } };
        this.publish();
        try {
          const reply = await readTranscript(
            this.read,
            { source: captured, ...(manifest.nextCursor ? { cursor: manifest.nextCursor } : {}) },
            signal,
            () => this.current(captured),
          );
          if (reply.kind !== 'manifest')
            throw makeTranscriptFailure('Expected transcript manifest.');
          this.manifestAdvance(manifest.nextCursor, reply.nextCursor);
          if (reply.parts.some((part) => manifest.parts.some((old) => old.partId === part.partId)))
            throw makeTranscriptFailure('Manifest continuation repeats a part.');
          if (this.state.manifest?.source !== manifest.source) return;
          this.state = {
            ...this.state,
            manifest: {
              ...manifest,
              parts: [
                ...manifest.parts,
                ...reuseParts(
                  this.snapshot?.run?.transcript &&
                    equal(this.snapshot.run.transcript.source, captured)
                    ? this.snapshot.run.transcript.parts
                    : (this.records.find((entry) => equal(entry.transcript?.source, captured))
                        ?.transcript?.parts ?? []),
                  reply.parts,
                ),
              ],
              nextCursor: reply.nextCursor,
              status: reply.nextCursor ? 'partial' : 'complete',
              error: null,
            },
          };
        } catch (error) {
          if (this.current() && !signal.aborted && this.state.manifest?.source === manifest.source)
            this.state = {
              ...this.state,
              manifest: {
                ...manifest,
                status:
                  normalizeApplicationError(error).code === 'Conflict' ? 'source-changed' : 'error',
                error: normalizeApplicationError(error).message,
              },
            };
          throw error;
        }
      },
      this.getFindSignal(captured),
    );
  }
  loadPart(source: ChatTranscriptSource, selection: ChatTranscriptSelection, restart = false) {
    const captured = structuredClone(
      decodeChatInput('getChatTranscriptContent', { source, selection }),
    );
    const selected = captured.selection!;
    const entryId = captured.source.kind === 'entry' ? captured.source.entryId : undefined;
    this.selectedEntry =
      this.records.find((entry) => entry.id === entryId) ??
      this.snapshot?.entries.find((entry) => entry.id === entryId);
    const key = getTranscriptKey([captured.source, selected]);
    let content = this.contents.get(key);
    if (restart) {
      this.jobs.get(key)?.abort.abort();
      this.jobs.delete(key);
      content = undefined;
    }
    content ??= {
      source: captured.source,
      selection: selected,
      chunks: [],
      loadedBytes: 0,
      loadedText: 0,
      retainedFrom: 0,
      nextCursor: null,
      status: 'partial',
      error: null,
    };
    this.contents.delete(key);
    this.contents.set(key, content);
    if (content.status === 'complete' || content.status === 'source-changed') {
      this.publish();
      return Promise.resolve();
    }
    const before = { ...content, chunks: [] };
    return this.run(
      key,
      async (signal) => {
        if (!this.dependencies.capable)
          throw makeTranscriptFailure(
            'This host requires an upgrade for transcript content.',
            'Unavailable',
          );
        this.contents.set(key, {
          ...(this.contents.get(key) ?? before),
          status: 'loading',
          error: null,
        });
        this.publish();
        try {
          const reply = await readTranscript(
            this.read,
            { ...captured, ...(before.nextCursor ? { cursor: before.nextCursor } : {}) },
            signal,
            () => this.current(captured.source),
          );
          if (reply.kind !== 'content' || reply.offset !== before.loadedBytes)
            throw makeTranscriptFailure('Transcript content has a missing or overlapping chunk.');
          const loadedBytes = reply.offset + countDecodedTranscriptBytes(reply);
          const chunk = {
            source: captured.source,
            selection: selected,
            offset: reply.offset,
            textOffset: before.loadedText,
            encoding: reply.encoding,
            data: reply.data,
          };
          const chunks = [...(this.contents.get(key)?.chunks ?? []), chunk];
          this.contents.set(key, {
            ...before,
            chunks,
            retainedFrom: chunks[0]?.offset ?? loadedBytes,
            loadedBytes,
            loadedText: before.loadedText + (reply.encoding === 'utf8' ? reply.data.length : 0),
            nextCursor: reply.nextCursor,
            status: reply.nextCursor ? 'partial' : 'complete',
            error: null,
          });
        } catch (error) {
          if (this.current() && !signal.aborted)
            this.contents.set(key, {
              ...(this.contents.get(key) ?? before),
              status:
                normalizeApplicationError(error).code === 'Conflict' ? 'source-changed' : 'error',
              error: normalizeApplicationError(error).message,
            });
          throw error;
        }
      },
      this.getFindSignal(captured.source),
    );
  }
  iterate(
    source: ChatTranscriptSource,
    options: {
      selection?: ChatTranscriptSelection;
      signal?: AbortSignal;
      onProgress?: (progress: TranscriptReadProgress) => void;
    } = {},
  ): AsyncGenerator<TranscriptChunk> {
    if (!this.dependencies.capable)
      throw makeTranscriptFailure(
        'This host requires an upgrade for complete transcript reads.',
        'Unavailable',
      );
    const captured = structuredClone(source);
    const selection = options.selection ? { ...options.selection } : undefined;
    const getEvidence = (selected?: ChatTranscriptSelection) => this.getLiveEvidence(selected);
    const manifestEvidence =
      captured.kind === 'live' && !selection ? structuredClone(getEvidence()) : undefined;
    const isCurrent = () =>
      this.current(captured) &&
      (captured.kind !== 'live' || !!selection || equal(manifestEvidence, getEvidence()));
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.lifetime.signal])
      : this.lifetime.signal;
    const settlements = new Set<Promise<unknown>>();
    const read: TranscriptRead = (input, options) =>
      this.command('getChatTranscriptContent', input, options?.signal, settlements);
    let proofState:
      | {
          selection: ChatTranscriptSelection;
          encoding: TranscriptChunk['encoding'];
          evidence: unknown;
        }
      | undefined;
    let progress: TranscriptReadProgress | undefined;
    const needsProof = () =>
      captured.kind === 'live' &&
      proofState &&
      !equal(proofState.evidence, getEvidence(proofState.selection));
    const verifyCurrent = async (budget: { remaining: number }) => {
      checkTranscriptRead(signal, isCurrent);
      if (captured.kind !== 'live' || !proofState) return;
      const selected = proofState;
      while (!equal(selected.evidence, getEvidence(selected.selection))) {
        if (budget.remaining === 0)
          throw makeTranscriptFailure(
            'Transcript prefix proof was repeatedly superseded.',
            'Conflict',
          );
        budget.remaining--;
        const evidence = structuredClone(getEvidence(selected.selection));
        const proof = await readTranscript(
          read,
          { source: captured, selection: selected.selection },
          signal,
          isCurrent,
        );
        if (proof.kind !== 'content' || proof.offset !== 0 || proof.encoding !== selected.encoding)
          throw makeTranscriptFailure('Transcript prefix proof does not match the captured part.');
        // A held proof covers only the evidence observed before its request.
        selected.evidence = evidence;
      }
      checkTranscriptRead(signal, isCurrent);
    };
    const iterator = iterateTranscriptSource({
      source: captured,
      selection,
      signal,
      isCurrent,
      read: async (input, options) => {
        const evidence = structuredClone(getEvidence(input.selection));
        const reply = await read(input, options);
        if (reply.kind === 'content' && input.selection)
          proofState = { selection: { ...input.selection }, encoding: reply.encoding, evidence };
        return reply;
      },
      onProgress: (value) => {
        progress = value;
      },
    });
    const onProgress = options.onProgress;
    return (async function* () {
      try {
        for (;;) {
          const next = await iterator.next();
          const budget = { remaining: 3 };
          for (;;) {
            await verifyCurrent(budget);
            checkTranscriptRead(signal, isCurrent);
            if (needsProof()) continue;
            if (progress) {
              const current = progress;
              progress = undefined;
              onProgress?.(current);
              checkTranscriptRead(signal, isCurrent);
              if (needsProof()) continue;
            }
            if (next.done) return;
            yield next.value;
            break;
          }
        }
      } finally {
        try {
          await iterator.return(undefined);
        } finally {
          // Consumers retain capacity until their own cancelled data/proof IO actually settles.
          await Promise.allSettled(settlements);
        }
      }
    })();
  }
  close() {
    this.cancelFind();
    this.alive = false;
    this.lifetime.abort();
    this.contents.clear();
    this.records = [];
    this.snapshot = undefined;
    this.selectedEntry = undefined;
    this.state = makeEmptyTranscriptState();
    this.published = this.state;
    for (const job of this.jobs.values()) job.abort.abort();
    return Promise.allSettled(this.pending.keys()).then(() => {});
  }
}
