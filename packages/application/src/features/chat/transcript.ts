import { Cause, Deferred, Effect, Exit, Fiber, FiberHandle, FiberMap, Option, Scope } from 'effect';
import type { ApplicationError } from '@moonbase/contracts/errors';
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
} from '@moonbase/contracts/chat';
import { decodeChatInput } from '@moonbase/contracts/chat-schema';
import { normalizeApplicationError } from '../../runtime/effect-client.ts';
import { sameTarget } from './saved.ts';
import type { TranscriptViewMemory, TranscriptView } from './view-memory.ts';
import {
  areTranscriptValuesEqual,
  checkTranscriptReply,
  countTranscriptBytes,
  getTranscriptKey,
  makeTranscriptFailure,
  trackTranscriptCursor,
} from './transcript-read.ts';
import {
  makeEmptyFindState,
  makeEmptyTranscriptState,
  measureTranscriptValue,
  transcriptLimits,
  type TranscriptState,
} from './transcript-state.ts';
import { isContentChanged, TranscriptContentCache } from './transcript-content.ts';
import {
  checkSnapshotSources,
  reuseSnapshot,
  TranscriptHistory,
  type HistoryDirection,
} from './transcript-history.ts';
import {
  appendManifestPage,
  findKnownParts,
  isManifestChanged,
  makeManifest,
} from './transcript-manifest.ts';
import { appendFindPage, TranscriptFindPass, type FindBoundary } from './transcript-find.ts';

type TranscriptDependencies = {
  chat: ChatClient;
  target: ChatTarget;
  backend: string;
  memory: TranscriptViewMemory;
  capable: boolean;
  streaming: boolean;
  findCapable: boolean;
  local: boolean;
  /** The selection's scope; the owner's read fibers live in a child of it. */
  scope: Scope.Scope;
  /** Defaults to `transcriptLimits.closeGraceMs`. */
  closeGraceMs?: number;
  publish: (state: TranscriptState, snapshot?: ChatSnapshot) => void;
};
type Work = Effect.Effect<void, ApplicationError>;
const historyJob = 'history',
  manifestJob = 'manifest';

/** Handles a failure (or thrown defect) of `effect`; interruption skips it by construction. */
const catchFailure =
  (handle: (error: ApplicationError) => void) =>
  <A>(effect: Effect.Effect<A, ApplicationError>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => handle(normalizeApplicationError(Cause.squash(cause)))),
      ),
    );
/** Observes a failure of `effect`, then fails with it; interruption skips it by construction. */
const tapFailure =
  (handle: (error: ApplicationError) => void) =>
  <A>(effect: Effect.Effect<A, ApplicationError>) =>
    effect.pipe(
      Effect.catchCause((cause) => {
        const error = normalizeApplicationError(Cause.squash(cause));
        handle(error);
        return Effect.fail(error);
      }),
    );
const interruptFiber = (fiber: Option.Option<Fiber.Fiber<unknown, unknown>>) => {
  if (Option.isSome(fiber)) fiber.value.interruptUnsafe();
};
/** A promise for the fiber's end that never rejects; failures were already published. */
const joinFiber = (fiber: Fiber.Fiber<void, unknown>) =>
  Effect.runPromise(Fiber.await(fiber)).then(() => undefined);

/**
 * One selected read owner, subordinate to the existing selection scope. Every read runs in a fiber
 * of this owner's scope: history, manifest and part reads are keyed in `jobs`, Find runs in
 * `search` and the active match's reveal in `reveal`. Interrupting a fiber is how a read is
 * cancelled or superseded, so a late reply cannot land after a switch, a new request or close.
 */
export class TranscriptOwner {
  private state = makeEmptyTranscriptState();
  private published = this.state;
  private publishedSnapshot?: ChatSnapshot;
  private selectedEntry?: ChatEntry;
  private snapshot?: ChatSnapshot;
  private history: TranscriptHistory;
  private contents = new TranscriptContentCache();
  private manifestAdvance = trackTranscriptCursor();
  private findBoundary: FindBoundary = { start: null, upper: undefined };
  private restorePending = true;
  private restoringView = false;
  private alive = true;
  private failed = false;
  private scope: Scope.Closeable;
  private jobs: FiberMap.FiberMap<string, void>;
  private search: FiberHandle.FiberHandle<void>;
  private reveal: FiberHandle.FiberHandle<void>;
  /** Job sources, so a snapshot can interrupt reads of a live source it made stale. */
  private jobSources = new Map<string, ChatTranscriptSource>();
  /** Content jobs started for the revealed Find match; cancelling the reveal interrupts them. */
  private revealJobs = new Set<string>();
  /**
   * Interrupting a read aborts its signal without waiting for the ChatClient's promise, so close
   * joins the promises still settling here, bounded by the close grace.
   */
  private reads = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  private dependencies: TranscriptDependencies;
  /** Publishes, then yields so a subscriber's re-entrant cancel stops the calling fiber. */
  private notify = Effect.sync(() => this.publish());
  constructor(dependencies: TranscriptDependencies) {
    this.dependencies = dependencies;
    this.state.view = dependencies.memory.get(dependencies.backend, dependencies.target);
    this.history = new TranscriptHistory(
      !this.state.view.anchor || !!this.state.view.anchor.source,
    );
    this.state.capabilities = {
      transcript: dependencies.capable ? 'available' : 'legacy',
      find: dependencies.findCapable && dependencies.capable ? 'available' : 'unavailable',
    };
    this.scope = Scope.forkUnsafe(dependencies.scope);
    [this.jobs, this.search, this.reveal] = Effect.runSync(
      Scope.provide(this.scope)(
        Effect.all([
          FiberMap.make<string, void>(),
          FiberHandle.make<void>(),
          FiberHandle.make<void>(),
        ]),
      ),
    );
  }
  getSnapshot() {
    return this.state;
  }
  private isCurrent(source?: ChatTranscriptSource) {
    return (
      this.alive &&
      !this.failed &&
      (!source ||
        (sameTarget(source.target, this.dependencies.target) &&
          (source.kind === 'entry' ||
            (this.snapshot?.observationStatus !== 'reconnecting' &&
              areTranscriptValuesEqual(this.snapshot?.run?.transcript?.source, source)))))
    );
  }
  private assertCurrent(source?: ChatTranscriptSource) {
    if (!this.isCurrent(source))
      throw makeTranscriptFailure(
        'Transcript source changed or is stale.',
        this.alive ? 'Conflict' : 'Cancelled',
      );
  }
  /** One ChatClient read; interrupting the calling fiber aborts its signal. */
  private call<K extends ChatCommand>(
    operation: K,
    input: ChatInput<K>,
    source?: ChatTranscriptSource,
  ): Effect.Effect<ChatOutput<K>, ApplicationError> {
    return Effect.try({
      try: () => {
        this.assertCurrent(source);
        // Transcript content inputs were decoded once by loadManifest/loadPart.
        return operation === 'getChatTranscriptContent' ? input : decodeChatInput(operation, input);
      },
      catch: normalizeApplicationError,
    }).pipe(
      Effect.flatMap((decoded) =>
        Effect.tryPromise({
          try: (signal) => {
            const read = this.dependencies.chat.command(operation, decoded, { signal });
            this.reads.add(read);
            const settle = () => this.reads.delete(read);
            void read.then(settle, settle);
            return read;
          },
          catch: normalizeApplicationError,
        }),
      ),
    );
  }
  private readContent(input: ChatInput<'getChatTranscriptContent'>) {
    return this.call('getChatTranscriptContent', input, input.source).pipe(
      Effect.map((reply) => checkTranscriptReply(input, reply)),
    );
  }
  /**
   * Forks `work` through `install` (a FiberMap key or a FiberHandle) but starts it only after
   * `admit` has published, so a subscriber that `admit` notifies can join or supersede it.
   */
  private start(
    install: (effect: Effect.Effect<void>) => Effect.Effect<Fiber.Fiber<void>>,
    work: Effect.Effect<void>,
    admit?: () => void,
  ) {
    const gate = Deferred.makeUnsafe<void>();
    const fiber = Effect.runSync(install(Effect.andThen(Deferred.await(gate), work)));
    admit?.();
    Deferred.doneUnsafe(gate, Exit.void);
    return fiber;
  }
  /**
   * Runs a keyed read. An existing job for `key` is joined, or interrupted and replaced when
   * `replace` is set. A failure is published as the transcript error.
   */
  private runJob(
    key: string,
    work: Work,
    options: { replace?: boolean; source?: ChatTranscriptSource; revealing?: boolean } = {},
  ): Promise<void> {
    if (!this.isCurrent()) return Promise.resolve();
    const running = FiberMap.getUnsafe(this.jobs, key);
    if (Option.isSome(running) && !options.replace) return joinFiber(running.value);
    const job = Effect.suspend(() => {
      this.assertCurrent();
      return work;
    }).pipe(
      catchFailure((error) => {
        this.state = { ...this.state, error: error.message };
      }),
      Effect.onExit((exit) =>
        Effect.withFiber((fiber) => Effect.sync(() => this.settleJob(key, fiber, exit))),
      ),
    );
    const fiber = this.start(
      (effect) => FiberMap.run(this.jobs, key, effect, { onlyIfMissing: !options.replace }),
      job,
      () => {
        if (options.source) this.jobSources.set(key, options.source);
        if (options.revealing) this.revealJobs.add(key);
        this.state = {
          ...this.state,
          error: null,
          loading: key === historyJob || this.state.loading,
        };
        this.publish();
      },
    );
    return joinFiber(fiber);
  }
  private settleJob(key: string, fiber: Fiber.Fiber<unknown, unknown>, exit: Exit.Exit<void>) {
    // A replaced job leaves the key to its successor; a closed map has no jobs left to settle.
    if (Option.getOrUndefined(FiberMap.getUnsafe(this.jobs, key)) !== fiber) return;
    this.jobSources.delete(key);
    this.revealJobs.delete(key);
    const interrupted = Exit.hasInterrupts(exit);
    if (interrupted) {
      if (this.contents.peek(key)?.status === 'loading')
        this.contents.mark(key, { status: 'partial' });
      if (key === manifestJob && this.state.manifest?.status === 'loading')
        this.state = { ...this.state, manifest: { ...this.state.manifest, status: 'partial' } };
    }
    this.state = {
      ...this.state,
      loading: key !== historyJob && FiberMap.hasUnsafe(this.jobs, historyJob),
    };
    // Whoever interrupted the job publishes its own change first.
    if (interrupted) queueMicrotask(() => this.publish());
    else this.publish();
  }
  private interruptJob(key: string) {
    interruptFiber(FiberMap.getUnsafe(this.jobs, key));
  }
  /** Summary budgets count each retained entry/part once, from cached per-value byte sizes. */
  private enforceBounds(direction: HistoryDirection) {
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
    while (summaries > transcriptLimits.summaryRecords || bytes > transcriptLimits.summaryBytes) {
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
        const removed = this.history.evictRecord(direction, this.state.view.anchor?.entryId);
        if (!removed) break;
        const other = others.get(removed.id);
        bytes -= sizes.get(removed.id)!;
        if (other) bytes += measureTranscriptValue(other);
        else summaries--;
        sizes.delete(removed.id);
      }
    }
    this.history.clampWindow();
  }
  /** Publishes whenever the window state or the accepted snapshot changed. */
  private publish(direction: HistoryDirection = this.history.following ? 'later' : 'earlier') {
    if (!this.alive) return;
    this.enforceBounds(direction);
    const entries = this.history.listWindow();
    const previous = this.state.entries;
    this.state = {
      ...this.state,
      entries:
        entries.length === previous.length &&
        entries.every((entry, index) => entry === previous[index])
          ? previous
          : entries,
      earlier: this.history.hasEarlier(entries.length),
      later: this.history.hasLater(),
      atLatest: this.history.following,
      content: this.contents.listContents(),
    };
    const changed = !areTranscriptValuesEqual(this.published, this.state);
    if (changed) this.published = this.state;
    else this.state = this.published;
    if (!changed && this.snapshot === this.publishedSnapshot) return;
    this.publishedSnapshot = this.snapshot;
    this.dependencies.publish(this.state, this.snapshot);
  }
  /** Trusts the ChatClient boundary's decoded, bounded snapshot; checks only its authority. */
  acceptSnapshot(input: ChatSnapshot) {
    checkSnapshotSources(input, this.dependencies.target);
    const old = this.snapshot;
    const next = reuseSnapshot(input, old, this.history);
    const { entries, run } = next;
    this.snapshot = old && areTranscriptValuesEqual(old, next) ? old : next;
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
          this.findBoundary.upper !== undefined &&
          this.findBoundary.upper !== input.transcriptBoundary,
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
    this.history.acceptSnapshot(entries, old, input);
    const stale = new Set<string>();
    for (const [key, source] of this.jobSources)
      if (source.kind === 'live' && !this.isCurrent(source)) stale.add(key);
    const changed = this.contents.markStale(
      (content) => !this.isCurrent(content.source) || isContentChanged(content, next),
    );
    for (const key of changed) stale.add(key);
    const manifest = this.state.manifest;
    if (
      manifest &&
      (!this.isCurrent(manifest.source) || isManifestChanged(manifest, old, { entries, run }))
    ) {
      this.state = {
        ...this.state,
        manifest: {
          ...manifest,
          status: 'source-changed',
          error: 'Transcript source changed or is stale. Reload the manifest.',
        },
      };
      stale.add(manifestJob);
    }
    for (const key of stale) this.interruptJob(key);
    this.publish();
  }
  /** Shows the last accepted snapshot as reconnecting while the watch is reopened. */
  markReconnecting() {
    if (this.snapshot && this.isCurrent())
      this.acceptSnapshot({ ...this.snapshot, observationStatus: 'reconnecting' });
  }
  fail(error: unknown) {
    this.failed = true;
    const failure = normalizeApplicationError(error).message;
    // Mark before interrupting, so interrupted loads keep their failure rather than `partial`.
    this.contents.markFailed(failure);
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
    this.cancelFind();
    // Settling removes each job from the map, so iterate a snapshot.
    for (const [, fiber] of Array.from(this.jobs)) fiber.interruptUnsafe();
    this.publish();
  }
  private cancelReveal() {
    interruptFiber(FiberHandle.getUnsafe(this.reveal));
    for (const key of this.revealJobs) this.interruptJob(key);
  }
  private cancelFind() {
    interruptFiber(FiberHandle.getUnsafe(this.search));
    this.cancelReveal();
    // A cancelled Find has no fixed boundary to replay or refresh against.
    this.findBoundary = { start: null, upper: undefined };
    this.state = { ...this.state, find: { ...this.state.find, revealing: false } };
  }
  /** Whether content for `source` is being read to reveal the active Find match. */
  private isRevealing(source: ChatTranscriptSource) {
    return (
      this.state.find.revealing && areTranscriptValuesEqual(this.state.find.active?.source, source)
    );
  }
  openFind() {
    this.state = { ...this.state, find: { ...this.state.find, open: true } };
    this.publish();
  }
  cancelFindReveal() {
    this.cancelReveal();
    if (!this.state.find.revealing) return;
    this.state = { ...this.state, find: { ...this.state.find, revealing: false } };
    this.publish();
  }
  closeFind() {
    this.cancelFind();
    this.state = { ...this.state, find: makeEmptyFindState() };
    this.publish();
  }
  findTranscript(query: string): Promise<void> {
    this.cancelFind();
    if (!this.alive) return Promise.resolve();
    const fiber = this.start(
      (effect) => FiberHandle.run(this.search, effect),
      this.searchTranscript(query),
      () => {
        this.state = {
          ...this.state,
          find: {
            ...makeEmptyFindState(),
            open: true,
            query,
            revealing: !!query,
            status: query ? 'searching' : 'idle',
          },
        };
        this.publish();
      },
    );
    return joinFiber(fiber);
  }
  private searchTranscript(query: string): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (!query) return;
      if (!this.isCurrent()) {
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
        return;
      }
      const target = this.dependencies.target;
      decodeChatInput('findChatTranscript', { target, query });
      if (this.state.capabilities.find !== 'available')
        throw makeTranscriptFailure(
          'Upgrade this host for complete conversation Find.',
          'Unavailable',
        );
      const pass = new TranscriptFindPass(target, query);
      let cursor: string | null = null;
      do {
        const read = yield* this.call('findChatTranscript', {
          target,
          query,
          ...(cursor ? { cursor } : {}),
        });
        const page = pass.checkPage(read, cursor, this.findBoundary);
        this.findBoundary = { start: page.startCursor, upper: page.upperEntryId };
        const previous = this.state.find;
        this.state = {
          ...this.state,
          find: appendFindPage(previous, page, this.snapshot?.transcriptBoundary),
        };
        yield* this.notify;
        const first = previous.active === null ? page.matches[0] : undefined;
        if (first && this.state.find.revealing) void this.revealMatch(first);
        cursor = page.nextCursor;
        if (cursor) yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));
      } while (cursor);
    }).pipe(
      catchFailure((error) => {
        this.state = {
          ...this.state,
          find: { ...this.state.find, status: 'error', error: error.message },
        };
        this.publish();
      }),
    );
  }
  /** Replaces any reveal with one of `match`; the search continues independently. */
  private revealMatch(match: ChatTranscriptMatch) {
    this.cancelReveal();
    return joinFiber(
      this.start((effect) => FiberHandle.run(this.reveal, effect), this.showMatch(match)),
    );
  }
  private showMatch(match: ChatTranscriptMatch): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (!this.state.find.revealing || !areTranscriptValuesEqual(this.state.find.active, match))
        return;
      this.interruptJob(historyJob);
      this.restoringView = false;
      this.history.following = false;
      this.restorePending = false;
      yield* this.readAround(match.source.entryId, undefined, 'earlier', true);
      this.setView({
        anchor: { entryId: match.source.entryId, partId: match.partId, offset: 0 },
        expanded: this.state.view.expanded,
      });
    }).pipe(catchFailure((error) => this.showFindError(error)));
  }
  private showFindError(error: ApplicationError) {
    this.state = { ...this.state, find: { ...this.state.find, error: error.message } };
    this.publish();
  }
  moveFind(direction: 'next' | 'previous') {
    if (!this.isCurrent() || !this.state.find.query) return Promise.resolve();
    const previous = this.state.find;
    const index = Math.max(0, (previous.activeIndex ?? -1) + (direction === 'next' ? 1 : -1));
    if (index >= previous.count) return Promise.resolve();
    this.cancelReveal();
    return joinFiber(
      this.start(
        (effect) => FiberHandle.run(this.reveal, effect),
        this.moveToMatch(previous, index),
      ),
    );
  }
  private moveToMatch(previous: TranscriptState['find'], index: number): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      let match: ChatTranscriptMatch | undefined = previous.matches[index - previous.retainedFrom];
      if (!match && previous.activeIndex === index) match = previous.active ?? undefined;
      if (!match) match = yield* this.replayFind(previous.query, index);
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
      yield* this.notify;
      yield* this.showMatch(match);
    }).pipe(catchFailure((error) => this.showFindError(error)));
  }
  /** Rereads Find pages from the fixed start to a match no longer retained in memory. */
  private replayFind(query: string, index: number) {
    return Effect.gen({ self: this }, function* () {
      let cursor = this.findBoundary.start,
        offset = 0;
      if (!cursor) throw makeTranscriptFailure('Find must be refreshed before replay.');
      const target = this.dependencies.target;
      const pass = new TranscriptFindPass(target, query);
      do {
        const read = yield* this.call('findChatTranscript', { target, query, cursor });
        const page = pass.checkPage(read, cursor, this.findBoundary);
        if (index < offset + page.matches.length) return page.matches[index - offset];
        offset += page.matches.length;
        cursor = page.nextCursor;
      } while (cursor);
      return undefined;
    });
  }
  restoreView() {
    if (!this.restorePending) return Promise.resolve();
    this.restorePending = false;
    const anchor = this.state.view.anchor;
    // View memory is a location hint; only content reads need source proofs.
    if (!anchor || anchor.source) return Promise.resolve();
    this.restoringView = true;
    return this.jumpToEntry(anchor.entryId, false).finally(() => {
      this.restoringView = false;
    });
  }
  private cancelViewRestore() {
    if (!this.restoringView) return;
    this.restoringView = false;
    this.interruptJob(historyJob);
    this.state = { ...this.state, loading: false };
  }
  showEarlier() {
    return this.move('earlier');
  }
  showLater() {
    return this.move('later');
  }
  private move(direction: HistoryDirection) {
    this.cancelFindReveal();
    const pending = FiberMap.getUnsafe(this.jobs, historyJob);
    if (Option.isSome(pending) && !this.restoringView) return joinFiber(pending.value);
    if (!this.isCurrent() || !this.state[direction])
      return Option.isSome(pending) ? joinFiber(pending.value) : Promise.resolve();
    this.cancelViewRestore();
    this.restorePending = false;
    // Freeze the reading window before loading can notify a subscriber.
    this.history.following = false;
    return this.runJob(historyJob, this.moveWindow(direction), { replace: true });
  }
  private moveWindow(direction: HistoryDirection): Work {
    return Effect.gen({ self: this }, function* () {
      const history = this.history,
        target = this.dependencies.target;
      const previous = history.windowStart;
      if (!history.shiftWindow(direction)) {
        if (this.dependencies.capable && history.records.length) {
          const edge = direction === 'earlier' ? this.state.entries[0] : this.state.entries.at(-1);
          const read = history.findAroundRead(direction, edge);
          if (read) yield* this.readAround(read.entryId, read.cursor, direction);
        } else if (direction === 'earlier') {
          const cursor = history.findOlderCursor(this.snapshot?.olderCursor);
          if (cursor) {
            const page = yield* this.call('getChatHistory', { target, cursor });
            history.applyOlderPage(page, cursor, target);
          }
        }
      }
      history.settleMove(direction);
      if (history.windowStart !== previous || this.state.entries.length)
        this.rememberWindow(direction);
      this.publish(direction);
    });
  }
  private readAround(
    entryId: string,
    cursor: string | undefined,
    direction: HistoryDirection,
    replace = false,
  ): Work {
    return Effect.gen({ self: this }, function* () {
      if (entryId === 'live')
        throw makeTranscriptFailure('Use an exact live-part anchor instead of a synthetic entry.');
      const target = this.dependencies.target;
      const page = yield* this.call('getChatHistoryAround', {
        target,
        entryId,
        ...(cursor ? { cursor } : {}),
      });
      this.history.checkAroundPage(page, target, { entryId, cursor, direction });
      this.history.applyAroundPage(page, direction, replace, this.snapshot?.entries[0]?.id);
    });
  }
  jumpToEntry(entryId: string, resetView = true) {
    if (resetView) {
      this.restorePending = false;
      this.restoringView = false;
      this.cancelFindReveal();
    }
    this.history.following = false;
    const work = Effect.gen({ self: this }, function* () {
      if (!this.dependencies.capable)
        throw makeTranscriptFailure(
          'This host requires an upgrade for transcript navigation.',
          'Unavailable',
        );
      yield* this.readAround(entryId, undefined, 'earlier', true);
      if (resetView)
        this.setView({
          anchor: { entryId, offset: 0 },
          expanded: this.state.view.anchor?.source ? [] : this.state.view.expanded,
        });
    });
    return this.runJob(historyJob, work, { replace: true });
  }
  jumpToLatest() {
    this.restoringView = false;
    this.cancelFindReveal();
    this.restorePending = false;
    const work = Effect.gen({ self: this }, function* () {
      const previous = this.snapshot;
      const snapshot = yield* this.call('getChat', { target: this.dependencies.target });
      this.history.resetToLatest();
      this.rememberView({
        anchor: null,
        expanded: this.state.view.anchor?.source ? [] : this.state.view.expanded,
      });
      // A watch received during this explicit read wins its coherent live boundary.
      this.acceptSnapshot(this.snapshot !== previous && this.snapshot ? this.snapshot : snapshot);
    });
    return this.runJob(historyJob, work, { replace: true });
  }
  /** Remembers the displayed edge row in the direction moved: oldest shown, or newest shown. */
  private rememberWindow(direction: HistoryDirection) {
    const entry = this.history.findWindowEdge(direction);
    this.rememberView({
      expanded: this.state.view.anchor?.source ? [] : this.state.view.expanded,
      anchor: this.history.following || !entry ? null : { entryId: entry.id, offset: 0 },
    });
  }
  /** View memory decodes once and returns the frozen view it remembered; invalid views throw. */
  private rememberView(view: TranscriptView) {
    const remembered = this.dependencies.memory.set(
      this.dependencies.backend,
      this.dependencies.target,
      view,
    );
    this.state = { ...this.state, view: remembered };
    return remembered;
  }
  setView(view: TranscriptView) {
    if (!this.alive) return;
    const captured = this.rememberView(view);
    this.cancelViewRestore();
    this.restorePending = false;
    if (captured.anchor) this.history.following = !!captured.anchor.source;
    this.publish();
  }
  private requireContentReads() {
    if (!this.dependencies.capable)
      throw makeTranscriptFailure(
        'This host requires an upgrade for transcript content.',
        'Unavailable',
      );
  }
  loadManifest(source: ChatTranscriptSource, restart = false) {
    const captured = decodeChatInput('getChatTranscriptContent', { source }).source;
    const replace = restart || !areTranscriptValuesEqual(this.state.manifest?.source, captured);
    if (replace) {
      this.manifestAdvance = trackTranscriptCursor();
      this.state = { ...this.state, manifest: makeManifest(captured) };
    }
    const manifest = this.state.manifest!;
    if (manifest.status === 'complete' || manifest.status === 'source-changed')
      return Promise.resolve();
    const read = Effect.gen({ self: this }, function* () {
      const reply = yield* this.readContent({
        source: captured,
        ...(manifest.nextCursor ? { cursor: manifest.nextCursor } : {}),
      });
      if (reply.kind !== 'manifest') throw makeTranscriptFailure('Expected transcript manifest.');
      this.manifestAdvance(manifest.nextCursor, reply.nextCursor);
      const known = findKnownParts(captured, this.snapshot, this.history.records);
      this.state = { ...this.state, manifest: appendManifestPage(manifest, reply, known) };
    }).pipe(
      tapFailure((error) => {
        this.state = {
          ...this.state,
          manifest: {
            ...manifest,
            status: error.code === 'Conflict' ? 'source-changed' : 'error',
            error: error.message,
          },
        };
      }),
    );
    const work = Effect.gen({ self: this }, function* () {
      this.requireContentReads();
      this.state = { ...this.state, manifest: { ...manifest, status: 'loading', error: null } };
      yield* this.notify;
      yield* read;
    });
    return this.runJob(manifestJob, work, {
      replace,
      source: captured,
      revealing: this.isRevealing(captured),
    });
  }
  loadPart(source: ChatTranscriptSource, selection: ChatTranscriptSelection, restart = false) {
    const captured = decodeChatInput('getChatTranscriptContent', { source, selection });
    const selected = captured.selection!;
    const entryId = captured.source.kind === 'entry' ? captured.source.entryId : undefined;
    this.selectedEntry =
      this.history.findRecord(entryId) ??
      this.snapshot?.entries.find((entry) => entry.id === entryId);
    const key = getTranscriptKey([captured.source, selected]);
    const content = this.contents.open(key, captured.source, selected, restart);
    if (content.status === 'complete' || content.status === 'source-changed') {
      this.publish();
      return Promise.resolve();
    }
    const before = { ...content, chunks: [] };
    const read = Effect.gen({ self: this }, function* () {
      const reply = yield* this.readContent({
        ...captured,
        ...(before.nextCursor ? { cursor: before.nextCursor } : {}),
      });
      if (reply.kind !== 'content')
        throw makeTranscriptFailure('Transcript content has a missing or overlapping chunk.');
      this.contents.append(key, before, reply);
    }).pipe(
      tapFailure((error) =>
        this.contents.mark(
          key,
          {
            status: error.code === 'Conflict' ? 'source-changed' : 'error',
            error: error.message,
          },
          before,
        ),
      ),
    );
    const work = Effect.gen({ self: this }, function* () {
      this.requireContentReads();
      this.contents.mark(key, { status: 'loading', error: null }, before);
      yield* this.notify;
      yield* read;
    });
    return this.runJob(key, work, {
      replace: restart,
      source: captured.source,
      revealing: this.isRevealing(captured.source),
    });
  }
  /**
   * Closing the owner's scope interrupts every read fiber at once. Close then joins the cancelled
   * ChatClient promises, but a client that ignores cancellation cannot hold Quit or a switch.
   */
  close() {
    if (this.closing) return this.closing;
    this.alive = false;
    this.contents.clear();
    this.history.clear();
    this.snapshot = undefined;
    this.selectedEntry = undefined;
    this.state = makeEmptyTranscriptState();
    this.published = this.state;
    const reads = [...this.reads];
    this.closing = Effect.runPromise(
      Scope.close(this.scope, Exit.void).pipe(
        Effect.andThen(Effect.promise(() => Promise.allSettled(reads))),
        Effect.timeoutOption(this.dependencies.closeGraceMs ?? transcriptLimits.closeGraceMs),
        Effect.asVoid,
      ),
    );
    return this.closing;
  }
}
