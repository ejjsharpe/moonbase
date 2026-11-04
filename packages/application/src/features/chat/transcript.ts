import { maximumChatReplyBytes } from '@moonbase/contracts/chat';
import type {
  ChatClient,
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
  type TranscriptReadProgress,
} from './transcript-read.ts';

export const transcriptLimits = {
  displayedRows: 128,
  summaryRecords: 256,
  summaryBytes: 2 * 1024 * 1024,
  contentBytes: 8 * 1024 * 1024,
} as const;
type ReadStatus = 'partial' | 'loading' | 'complete' | 'error' | 'source-changed';
export type TranscriptContentState = {
  source: ChatTranscriptSource;
  selection: ChatTranscriptSelection;
  chunks: TranscriptChunk[];
  loadedBytes: number;
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
  capabilities: { transcript: 'unknown' | 'available' | 'legacy'; find: 'unavailable' };
  observation: 'inactive' | 'local' | 'streaming' | 'legacy' | 'reconnecting' | 'failed';
  entries: ChatEntry[];
  earlier: boolean;
  later: boolean;
  atLatest: boolean;
  loading: boolean;
  error: string | null;
  view: TranscriptView;
  viewStatus: 'pending' | 'ready' | 'source-changed' | 'unavailable';
  viewError: string | null;
  manifest: TranscriptManifestState | null;
  content: TranscriptContentState[];
  retained: { summaries: number; summaryBytes: number; contentBytes: number };
};
export function makeEmptyTranscriptState(): TranscriptState {
  return {
    capabilities: { transcript: 'unknown', find: 'unavailable' },
    observation: 'inactive',
    entries: [],
    earlier: false,
    later: false,
    atLatest: true,
    loading: false,
    error: null,
    view: { anchor: null, expanded: [] },
    viewStatus: 'ready',
    viewError: null,
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
  local: boolean;
  publish: (state: TranscriptState, snapshot?: ChatSnapshot) => void;
};
type Navigation = {
  entryId: string;
  upperEntryId: string;
  olderCursor: string | null;
  newerCursor: string | null;
};
/** One selected read owner, subordinate to the existing selection scope. */
export class TranscriptOwner {
  private state = makeEmptyTranscriptState();
  private published = this.state;
  private selectedEntry?: ChatEntry;
  private viewEvidence: unknown;
  private records: ChatEntry[] = []; // newest first; public window is oldest first
  private start = 0;
  private snapshot?: ChatSnapshot;
  private navigation?: Navigation;
  private latestCursor: string | null = null;
  private olderEnd = true;
  private newerEnd = true;
  private following = true;
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
  private dependencies: TranscriptDependencies;
  constructor(dependencies: TranscriptDependencies) {
    this.dependencies = dependencies;
    this.state.view = dependencies.memory.get(dependencies.backend, dependencies.target);
    this.following = !this.state.view.anchor || !!this.state.view.anchor.source;
    if (this.state.view.anchor?.source) this.state.viewStatus = 'pending';
    this.state.capabilities = {
      transcript: dependencies.capable ? 'available' : 'legacy',
      find: 'unavailable',
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
  ): Promise<ChatOutput<K>> {
    this.assertCurrent();
    const abort = new AbortController();
    const source =
      operation === 'getChatTranscriptContent'
        ? (input as ChatInput<'getChatTranscriptContent'>).source
        : undefined;
    this.assertCurrent(source);
    const combined = AbortSignal.any([
      ...(signal ? [signal] : []),
      this.lifetime.signal,
      abort.signal,
    ]);
    const pending = this.dependencies.chat.command(
      operation,
      structuredClone(decodeChatInput(operation, input)),
      {
        signal: combined,
      },
    );
    this.pending.set(pending, { abort, source });
    void pending.then(
      () => this.pending.delete(pending),
      () => this.pending.delete(pending),
    );
    const result = await awaitTranscriptRead(pending, combined);
    this.assertCurrent();
    if (signal?.aborted || abort.signal.aborted)
      throw makeTranscriptFailure('Transcript read cancelled.', 'Cancelled');
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
      summaries:
        entries.length + (this.state.manifest?.parts.length ?? 0) + (this.viewEvidence ? 1 : 0),
      summaryBytes: countTranscriptBytes({
        entries,
        manifest: this.state.manifest,
        navigation: this.navigation,
        view: this.state.view,
        viewEvidence: this.viewEvidence,
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
      const pinned = this.state.view.anchor?.entryId;
      const indices = this.records.map((_, index) => index);
      if (direction === 'later') indices.reverse();
      const index = indices.find((index) => pinned !== this.records[index].id);
      if (index !== undefined) {
        this.records.splice(index, 1);
        if (index < this.start) this.start--;
        if (direction === 'earlier') this.newerEnd = false;
        else this.olderEnd = false;
      } else if (this.state.manifest?.parts.length) {
        this.state = {
          ...this.state,
          manifest: {
            ...this.state.manifest,
            parts: this.state.manifest.parts.slice(1),
            omittedParts: this.state.manifest.omittedParts + 1,
          },
        };
      } else break;
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
    this.state = { ...this.state, observation };
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
      this.records = this.records.map((entry) =>
        reuseEntry(entry, entries.find((value) => value.id === entry.id) ?? entry),
      );
      if (old && old.transcriptBoundary !== input.transcriptBoundary) this.newerEnd = false;
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
    this.updateLiveView();
    this.publish(false);
    if (!this.jobs.has('history')) void this.restoreLiveView();
    return this.snapshot;
  }
  fail(error: unknown) {
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
      loading: false,
      ...(this.state.view.anchor?.source
        ? { viewStatus: 'source-changed' as const, viewError: failure }
        : {}),
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
  private getLiveAnchorIdentity(anchor: TranscriptView['anchor']) {
    if (!anchor?.source) return null;
    return {
      backendId: anchor.backendId,
      source: anchor.source,
      partId: anchor.partId,
      bytes: anchor.bytes,
      revision: anchor.revision,
    };
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
  private cancelViewRestore() {
    this.jobs.get('view')?.abort.abort();
    this.jobs.delete('view');
  }
  private updateLiveView() {
    const anchor = this.state.view.anchor;
    if (
      !anchor?.source ||
      this.state.viewStatus === 'source-changed' ||
      this.state.viewStatus === 'unavailable'
    )
      return;
    if (!this.snapshot || this.snapshot.observationStatus === 'reconnecting') {
      this.cancelViewRestore();
      this.state = { ...this.state, viewStatus: 'pending', viewError: null };
      return;
    }
    if (!this.current(anchor.source)) {
      this.cancelViewRestore();
      this.viewEvidence = undefined;
      this.state = {
        ...this.state,
        viewStatus: 'source-changed',
        viewError: 'The anchored live source retired or changed. Jump to latest or reload.',
      };
      return;
    }
    const transcript = this.snapshot.run!.transcript!;
    const part = transcript.parts.find((part) => part.partId === anchor.partId);
    const evidence = this.getLiveEvidence(anchor);
    if ((part && part.availability !== 'available') || (!part && transcript.nextCursor === null)) {
      this.cancelViewRestore();
      this.viewEvidence = undefined;
      this.state = {
        ...this.state,
        viewStatus: 'unavailable',
        viewError: 'The anchored live part is unavailable. Jump to latest or reload.',
      };
    } else if (
      (part?.bytes === anchor.bytes && part.revision === anchor.revision) ||
      (this.viewEvidence && equal(this.viewEvidence, evidence))
    ) {
      this.cancelViewRestore();
      this.viewEvidence = evidence;
      this.state = { ...this.state, viewStatus: 'ready', viewError: null };
    } else this.state = { ...this.state, viewStatus: 'pending', viewError: null };
  }
  private restoreLiveView(): Promise<void> {
    const anchor = this.state.view.anchor;
    if (
      !anchor?.source ||
      this.state.viewStatus !== 'pending' ||
      !this.current(anchor.source) ||
      this.jobs.has('history')
    )
      return Promise.resolve();
    const isCurrent = () =>
      this.current(anchor.source) &&
      equal(this.getLiveAnchorIdentity(anchor), this.getLiveAnchorIdentity(this.state.view.anchor));
    return this.run('view', async (signal) => {
      try {
        let evidence: unknown;
        const iterator = this.iterate(anchor.source, {
          selection: { partId: anchor.partId, bytes: anchor.bytes, revision: anchor.revision },
          signal,
          onProgress: () => {
            evidence = this.getLiveEvidence(anchor);
          },
        });
        try {
          const first = await iterator.next();
          checkTranscriptRead(signal, isCurrent);
          if (first.done)
            throw makeTranscriptFailure('The anchored live part is unavailable.', 'Unavailable');
          if (!equal(evidence, this.getLiveEvidence(anchor)))
            throw makeTranscriptFailure(
              'Live evidence changed after the anchor proof. Reload the selected part.',
              'Conflict',
            );
          this.viewEvidence = evidence;
          this.state = { ...this.state, viewStatus: 'ready', viewError: null };
        } finally {
          await iterator.return(undefined);
        }
      } catch (error) {
        if (!signal.aborted && isCurrent()) {
          const failure = normalizeApplicationError(error);
          this.state = {
            ...this.state,
            viewStatus: failure.code === 'Conflict' ? 'source-changed' : 'unavailable',
            viewError: failure.message,
          };
        }
      }
    });
  }
  restore() {
    const anchor = this.state.view.anchor;
    if (anchor?.source) return this.restoreLiveView();
    return anchor ? this.around(anchor.entryId, false) : Promise.resolve();
  }
  private run(name: string, work: (signal: AbortSignal) => Promise<void>) {
    if (!this.current()) return Promise.resolve();
    const old = this.jobs.get(name);
    if (old) return old.promise;
    const job = { abort: new AbortController(), promise: Promise.resolve() };
    this.jobs.set(name, job);
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
        if (this.jobs.get(name) !== job) return;
        this.jobs.delete(name);
        if (this.alive) {
          this.state = { ...this.state, loading: this.jobs.has('history') };
          this.publish();
        }
      });
    this.state = {
      ...this.state,
      error: name === 'view' ? this.state.error : null,
      loading: name === 'history' || this.state.loading,
    };
    this.publish();
    return job.promise;
  }
  earlier = () => this.move('earlier');
  later = () => this.move('later');
  private move(direction: 'earlier' | 'later') {
    const pending = this.jobs.get('history');
    if (pending) return pending.promise;
    if (!this.current() || !this.state[direction]) return Promise.resolve();
    this.cancelViewRestore();
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
        if (nav && cursor) await this.readAround(nav.entryId, cursor, direction, signal);
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
    };
    this.olderEnd = page.olderCursor === null;
    this.newerEnd =
      page.newerCursor === null && this.snapshot?.entries[0]?.id === this.records[0]?.id;
    this.start =
      direction === 'earlier'
        ? Math.max(0, this.records.length - transcriptLimits.displayedRows)
        : 0;
  }
  around(entryId: string, resetView = true) {
    this.cancelViewRestore();
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
    this.cancelViewRestore();
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
      this.viewEvidence = undefined;
      this.state = {
        ...this.state,
        view: {
          anchor: null,
          expanded: this.state.view.anchor?.source ? [] : this.state.view.expanded,
        },
        viewStatus: 'ready',
        viewError: null,
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
    const previous = this.state.view.anchor;
    this.dependencies.memory.set(this.dependencies.backend, this.dependencies.target, view);
    const captured = this.dependencies.memory.get(
      this.dependencies.backend,
      this.dependencies.target,
    );
    if (!equal(this.getLiveAnchorIdentity(previous), this.getLiveAnchorIdentity(captured.anchor))) {
      this.cancelViewRestore();
      this.viewEvidence = undefined;
    }
    this.state = {
      ...this.state,
      view: captured,
      viewStatus: captured.anchor?.source ? 'pending' : 'ready',
      viewError: null,
    };
  }
  setView(view: TranscriptView) {
    if (!this.alive) return;
    const captured = decodeTranscriptView(
      this.dependencies.backend,
      this.dependencies.target,
      view,
    );
    if (captured.anchor?.source) this.assertCurrent(captured.anchor.source);
    this.rememberView(captured);
    if (captured.anchor) this.following = !!captured.anchor.source;
    this.updateLiveView();
    this.publish();
    void this.restoreLiveView();
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
    return this.run('manifest', async (signal) => {
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
        if (reply.kind !== 'manifest') throw makeTranscriptFailure('Expected transcript manifest.');
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
    });
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
    return this.run(key, async (signal) => {
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
          encoding: reply.encoding,
          data: reply.data,
        };
        const chunks = [...(this.contents.get(key)?.chunks ?? []), chunk];
        this.contents.set(key, {
          ...before,
          chunks,
          retainedFrom: chunks[0]?.offset ?? loadedBytes,
          loadedBytes,
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
    });
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
          this.read,
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
        const reply = await this.read(input, options);
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
        await iterator.return(undefined);
      }
    })();
  }
  close() {
    this.alive = false;
    this.lifetime.abort();
    this.contents.clear();
    this.records = [];
    this.snapshot = undefined;
    this.selectedEntry = undefined;
    this.viewEvidence = undefined;
    this.state = makeEmptyTranscriptState();
    this.published = this.state;
    for (const job of this.jobs.values()) job.abort.abort();
    return Promise.allSettled(this.pending.keys()).then(() => {});
  }
}
