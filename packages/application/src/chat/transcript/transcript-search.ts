import { Deferred, Effect, FiberHandle, type Scope } from 'effect';
import type { ChatTranscriptMatch } from '@moonbase/contracts/chat';
import { areJsonValuesEqual } from '@moonbase/contracts/common';
import { describeChatFailure } from '../chat-errors.ts';
import { catchReadFailure, TranscriptReadError } from './transcript-errors.ts';
import { appendFindPage, TranscriptFindPass } from './transcript-find.ts';
import { admitThrough, behindGate, joinRead } from './transcript-gate.ts';
import type { TranscriptJobs } from './transcript-jobs.ts';
import { makeEmptyFindState, type TranscriptFindState } from './transcript-state.ts';
import type { TranscriptFailure, TranscriptStore } from './transcript-store.ts';

/**
 * A transcript's Find: one search at a time, and one reveal of its active match. A newer query, or
 * moving to another match, replaces them; closing the scope interrupts both.
 */
export type TranscriptSearch = {
  readonly openFind: Effect.Effect<void>;
  readonly closeFind: Effect.Effect<void>;
  readonly findTranscript: (query: string) => Effect.Effect<void>;
  readonly moveFind: (direction: 'next' | 'previous') => Effect.Effect<void>;
  /** Stops revealing the active match, keeping the query and its results. */
  readonly cancelFindReveal: Effect.Effect<void>;
  /**
   * Drops the fixed boundary and the reveal, synchronously, for a caller that then runs `stopFind`
   * once its own change is made.
   */
  readonly forgetFind: () => void;
  /** Interrupts the search, the reveal and the reads started for it. */
  readonly stopFind: Effect.Effect<void>;
};

export const makeTranscriptSearch = (
  store: TranscriptStore,
  jobs: TranscriptJobs,
  /** Shows the match's entry: navigation's reveal. */
  revealEntry: (entryId: string) => Effect.Effect<void, TranscriptFailure>,
): Effect.Effect<TranscriptSearch, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { target, limits } = store.dependencies;
    // Each forks synchronously and interrupts the fiber it replaces in the same step.
    const forkSearch = yield* Effect.flatMap(FiberHandle.make<void>(), (handle) =>
      Effect.map(FiberHandle.runtime(handle)<never>(), (fork) => ({ handle, fork })),
    );
    const forkReveal = yield* Effect.flatMap(FiberHandle.make<void>(), (handle) =>
      Effect.map(FiberHandle.runtime(handle)<never>(), (fork) => ({ handle, fork })),
    );
    const setFind = (find: Partial<TranscriptFindState>) => {
      store.state = { ...store.state, find: { ...store.state.find, ...find } };
    };
    const showFindError = (error: unknown) =>
      Effect.suspend(() => {
        setFind({ error: describeChatFailure(error) });
        return store.publish();
      });
    const interruptRevealReads = jobs.interrupt((read) => read.revealing);
    const stopReveal = Effect.andThen(FiberHandle.clear(forkReveal.handle), interruptRevealReads);
    const stopFind = Effect.andThen(FiberHandle.clear(forkSearch.handle), stopReveal);
    // A cancelled Find has no fixed boundary to replay or refresh against.
    const forgetFind = () => {
      store.findBoundary = { start: null, upper: undefined };
      setFind({ revealing: false });
    };

    const showMatch = (match: ChatTranscriptMatch) =>
      Effect.suspend(() => {
        const { find } = store.state;
        if (!find.revealing || !areJsonValuesEqual(find.active, match)) return Effect.void;
        return revealEntry(match.source.entryId);
      }).pipe(catchReadFailure(showFindError));
    /** Replaces any reveal with one of `match`; the search continues without waiting for it. */
    const revealMatch = (match: ChatTranscriptMatch) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        forkReveal.fork(behindGate(gate, showMatch(match)));
        yield* admitThrough(gate, interruptRevealReads);
      });
    const search = (query: string) =>
      Effect.gen(function* () {
        if (!query) return;
        if (!store.isCurrent()) {
          setFind({
            status: 'error',
            revealing: false,
            error: 'Reconnect or reopen this conversation before using Find.',
          });
          return yield* store.publish();
        }
        const pass = new TranscriptFindPass(target, query);
        let cursor: string | null = null;
        do {
          const read = yield* store.read('findChatTranscript', {
            target,
            query,
            ...(cursor ? { cursor } : {}),
          });
          const page = pass.checkPage(read, cursor, store.findBoundary);
          store.findBoundary = { start: page.startCursor, upper: page.upperEntryId };
          const previous = store.state.find;
          store.state = {
            ...store.state,
            find: appendFindPage(
              previous,
              page,
              store.snapshot?.transcriptBoundary,
              limits.findMatches,
            ),
          };
          yield* store.publish();
          const first = previous.active === null ? page.matches[0] : undefined;
          if (first && store.state.find.revealing) yield* revealMatch(first);
          cursor = page.nextCursor;
          if (cursor) yield* Effect.yieldNow;
        } while (cursor);
      }).pipe(
        catchReadFailure((error) =>
          Effect.suspend(() => {
            setFind({ status: 'error', error: describeChatFailure(error) });
            return store.publish();
          }),
        ),
      );
    /** Rereads Find pages from the fixed start to a match no longer retained in memory. */
    const replayFind = (query: string, index: number) =>
      Effect.gen(function* () {
        let cursor = store.findBoundary.start,
          offset = 0;
        if (!cursor)
          return yield* Effect.fail(
            new TranscriptReadError({ problem: 'find-replay-unavailable' }),
          );
        const pass = new TranscriptFindPass(target, query);
        while (cursor) {
          const read = yield* store.read('findChatTranscript', { target, query, cursor });
          const page = pass.checkPage(read, cursor, store.findBoundary);
          if (index < offset + page.matches.length) return page.matches[index - offset];
          offset += page.matches.length;
          cursor = page.nextCursor;
        }
        return undefined;
      });
    const moveToMatch = (previous: TranscriptFindState, index: number) =>
      Effect.gen(function* () {
        let match: ChatTranscriptMatch | undefined =
          previous.matches[index - previous.retainedFrom];
        if (!match && previous.activeIndex === index) match = previous.active ?? undefined;
        if (!match) match = yield* replayFind(previous.query, index);
        if (!match)
          return yield* Effect.fail(new TranscriptReadError({ problem: 'find-match-gone' }));
        setFind({ active: match, activeIndex: index, error: null, revealing: true });
        yield* store.publish();
        yield* showMatch(match);
      }).pipe(catchReadFailure(showFindError));

    return {
      openFind: Effect.suspend(() => {
        setFind({ open: true });
        return store.publish();
      }),
      closeFind: Effect.suspend(() => {
        forgetFind();
        store.state = { ...store.state, find: makeEmptyFindState() };
        return Effect.andThen(stopFind, store.publish());
      }),
      cancelFindReveal: Effect.suspend(() => {
        const revealing = store.state.find.revealing;
        setFind({ revealing: false });
        return Effect.andThen(stopReveal, revealing ? store.publish() : Effect.void);
      }),
      findTranscript: (query) =>
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>();
          forgetFind();
          store.state = {
            ...store.state,
            find: {
              ...makeEmptyFindState(),
              open: true,
              query,
              revealing: !!query,
              status: query ? 'searching' : 'idle',
            },
          };
          const fiber = forkSearch.fork(behindGate(gate, search(query)));
          yield* admitThrough(gate, Effect.andThen(stopReveal, store.publish()));
          yield* joinRead(fiber);
        }),
      moveFind: (direction) =>
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>();
          const previous = store.state.find;
          if (!store.isCurrent() || !previous.query) return;
          const index = Math.max(0, (previous.activeIndex ?? -1) + (direction === 'next' ? 1 : -1));
          if (index >= previous.count) return;
          const fiber = forkReveal.fork(behindGate(gate, moveToMatch(previous, index)));
          yield* admitThrough(gate, interruptRevealReads);
          yield* joinRead(fiber);
        }),
      forgetFind,
      stopFind,
    } satisfies TranscriptSearch;
  });
