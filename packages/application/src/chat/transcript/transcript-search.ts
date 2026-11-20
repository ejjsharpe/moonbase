import { Effect, Fiber, FiberHandle, type Scope } from 'effect';
import type { ChatTranscriptMatch } from '@moonbase/contracts/chat';
import { areJsonValuesEqual } from '@moonbase/contracts/common';
import { describeChatFailure } from '../chat-errors.ts';
import { catchReadFailure, TranscriptReadError } from './transcript-errors.ts';
import { appendFindPage, TranscriptFindPass } from './transcript-find.ts';
import { joinRead, type TranscriptJobs } from './transcript-jobs.ts';
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
   * Drops the fixed boundary, synchronously, for a caller that then stops Find and publishes it no
   * longer revealing.
   */
  readonly forgetFind: () => void;
  /**
   * Interrupts the search, the reveal and the reads started for it, synchronously, on behalf of
   * fiber `by`, and returns them to wait for: none publishes again once this returns.
   */
  readonly interruptFindUnsafe: (by: number) => readonly Fiber.Fiber<void>[];
};

export const makeTranscriptSearch = (
  store: TranscriptStore,
  jobs: TranscriptJobs,
  /** Shows the match's entry: navigation's reveal. */
  revealEntry: (entryId: string) => Effect.Effect<void, TranscriptFailure>,
): Effect.Effect<TranscriptSearch, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { chat, target, limits } = store.dependencies;
    // Running one interrupts the fiber it replaces.
    const searches = yield* FiberHandle.make<void, never>();
    const reveals = yield* FiberHandle.make<void, never>();
    const updateFind = (find: Partial<TranscriptFindState>) =>
      store.update((state) => ({ ...state, find: { ...state.find, ...find } }));
    const showFindError = (error: unknown) => updateFind({ error: describeChatFailure(error) });
    const interruptRevealReads = jobs.interrupt((read) => read.revealing);
    const stopReveal = Effect.andThen(FiberHandle.clear(reveals), interruptRevealReads);
    /** Interrupts every fiber of Find before waiting on any, so none publishes during the wait. */
    const interruptFindUnsafe = (by: number) => {
      const stopped: Fiber.Fiber<void>[] = [];
      for (const handle of [searches, reveals]) {
        const fiber = handle.state._tag === 'Open' ? handle.state.fiber : undefined;
        if (fiber) stopped.push(fiber);
      }
      for (const fiber of stopped) fiber.interruptUnsafe(by);
      return [...stopped, ...jobs.interruptUnsafe((read) => read.revealing, by)];
    };
    const stopFind = Effect.withFiber((self) => Fiber.awaitAll(interruptFindUnsafe(self.id))).pipe(
      Effect.asVoid,
    );
    // A cancelled Find has no fixed boundary to replay or refresh against.
    const forgetFind = () => {
      store.findBoundary = { start: null, upper: undefined };
    };

    const showMatch = (match: ChatTranscriptMatch) =>
      Effect.suspend(() => {
        const { find } = store.state;
        if (!find.revealing || !areJsonValuesEqual(find.active, match)) return Effect.void;
        return revealEntry(match.source.entryId);
      }).pipe(catchReadFailure(showFindError));
    /** Replaces any reveal with one of `match`; the search continues without waiting for it. */
    const revealMatch = (match: ChatTranscriptMatch) =>
      Effect.andThen(interruptRevealReads, FiberHandle.run(reveals, showMatch(match)));
    const search = (query: string) =>
      Effect.gen(function* () {
        if (!query) return;
        if (!store.isCurrent())
          return yield* updateFind({
            status: 'error',
            revealing: false,
            error: 'Reconnect or reopen this conversation before using Find.',
          });
        const pass = new TranscriptFindPass(target, query);
        let cursor: string | null = null;
        do {
          const read = yield* chat.findChatTranscript({
            target,
            query,
            ...(cursor ? { cursor } : {}),
          });
          const page = pass.checkPage(read, cursor, store.findBoundary);
          store.findBoundary = { start: page.startCursor, upper: page.upperEntryId };
          const previous = store.state.find;
          const find = appendFindPage(
            previous,
            page,
            store.state.snapshot?.transcriptBoundary,
            limits.findMatches,
          );
          yield* store.update((state) => ({ ...state, find }));
          const first = previous.active === null ? page.matches[0] : undefined;
          if (first && store.state.find.revealing) yield* revealMatch(first);
          cursor = page.nextCursor;
          if (cursor) yield* Effect.yieldNow;
        } while (cursor);
      }).pipe(
        catchReadFailure((error) =>
          updateFind({ status: 'error', error: describeChatFailure(error) }),
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
          const read = yield* chat.findChatTranscript({ target, query, cursor });
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
        yield* updateFind({ active: match, activeIndex: index, error: null, revealing: true });
        yield* showMatch(match);
      }).pipe(catchReadFailure(showFindError));

    return {
      openFind: updateFind({ open: true }),
      closeFind: Effect.suspend(() => {
        forgetFind();
        return Effect.andThen(
          stopFind,
          store.update((state) => ({ ...state, find: makeEmptyFindState() })),
        );
      }),
      cancelFindReveal: Effect.andThen(updateFind({ revealing: false }), stopReveal),
      findTranscript: (query) =>
        Effect.gen(function* () {
          // The search it replaces ends before Find shows this one, so it can't write over it.
          yield* stopFind;
          forgetFind();
          yield* store.update((state) => ({
            ...state,
            find: {
              ...makeEmptyFindState(),
              open: true,
              query,
              revealing: !!query,
              status: query ? 'searching' : 'idle',
            },
          }));
          yield* joinRead(yield* FiberHandle.run(searches, search(query)));
        }),
      moveFind: (direction) =>
        Effect.gen(function* () {
          const previous = store.state.find;
          if (!store.isCurrent() || !previous.query) return;
          const index = Math.max(0, (previous.activeIndex ?? -1) + (direction === 'next' ? 1 : -1));
          if (index >= previous.count) return;
          yield* interruptRevealReads;
          yield* joinRead(yield* FiberHandle.run(reveals, moveToMatch(previous, index)));
        }),
      forgetFind,
      interruptFindUnsafe,
    } satisfies TranscriptSearch;
  });
