import { Effect } from 'effect';
import type { ChatSnapshot } from '@moonbase/contracts/chat';
import { checkTranscript, type TranscriptReadError } from './transcript-errors.ts';
import type { HistoryDirection } from './transcript-history.ts';
import { historyJob, joinRead, type TranscriptJobs } from './transcript-jobs.ts';
import { findRowEntryId, getEntryRowKey, isLiveRowKey } from './transcript-rows.ts';
import type { TranscriptFailure, TranscriptStore } from './transcript-store.ts';
import type { TranscriptView } from './transcript-view-memory.ts';

/**
 * Where a transcript's reader is: paging history, jumping to an entry or the latest, restoring the
 * remembered view, and saving the view the reader scrolled to. One history read runs at a time.
 */
export type TranscriptNavigation = {
  readonly restoreView: Effect.Effect<void>;
  readonly showEarlier: Effect.Effect<void>;
  readonly showLater: Effect.Effect<void>;
  readonly jumpToEntry: (entryId: string) => Effect.Effect<void>;
  readonly jumpToLatest: Effect.Effect<void>;
  readonly setView: (view: TranscriptView) => Effect.Effect<void, TranscriptReadError>;
  /**
   * Saves the view `update` makes of the current one, read and saved in one step; one that returns
   * the current view unchanged saves nothing.
   */
  readonly updateView: (
    update: (view: TranscriptView) => TranscriptView,
  ) => Effect.Effect<void, TranscriptReadError>;
  /** Shows a Find match's entry at the top, reading around it unless retained. */
  readonly revealEntry: (entryId: string) => Effect.Effect<void, TranscriptFailure>;
};

export function makeTranscriptNavigation(
  store: TranscriptStore,
  jobs: TranscriptJobs,
  options: {
    acceptSnapshot: (snapshot: ChatSnapshot) => Effect.Effect<void, TranscriptReadError>;
    /** The reader's own navigation ends a Find reveal. */
    cancelFindReveal: Effect.Effect<void>;
  },
): TranscriptNavigation {
  const { chat, target } = store.dependencies;
  const { history } = store;
  let restorePending = true,
    restoringView = false;
  const interruptHistory = jobs.remove(historyJob);

  const readAround = (
    entryId: string,
    cursor: string | undefined,
    direction: HistoryDirection,
    replace = false,
  ) =>
    Effect.gen(function* () {
      const dataset = history.dataset;
      const page = yield* chat.getChatHistoryAround({
        target,
        entryId,
        ...(cursor ? { cursor } : {}),
      });
      // A snapshot that replaced the records during the read (the reader follows the live edge)
      // leaves the page nothing to extend.
      if (!replace && history.dataset !== dataset) return;
      history.checkAroundPage(page, target, { entryId, cursor, direction });
      history.applyAroundPage(page, direction, replace, store.state.snapshot?.entries[0]?.id);
    });
  const readPage = (direction: HistoryDirection) =>
    Effect.gen(function* () {
      const read = history.findAroundRead(direction);
      const cursor = store.state.snapshot?.olderCursor;
      if (read) yield* readAround(read.entryId, read.cursor, direction);
      else if (direction === 'earlier' && cursor) {
        // With no records to read around, history continues from the snapshot's older cursor.
        const dataset = history.dataset;
        const page = yield* chat.getChatHistory({ target, cursor });
        if (history.dataset === dataset) history.applyOlderPage(page, cursor, target);
      }
      yield* store.update(undefined, direction);
    });
  /**
   * Pages history, joining a page read that runs; a page replaces a view restore. The list pages
   * on its own near an edge, so a page leaves a Find reveal alone: the reader's own input ends it.
   */
  const move = (direction: HistoryDirection) =>
    Effect.suspend(() => {
      const pending = jobs.running(historyJob);
      if (pending && !restoringView) return joinRead(pending);
      if (!store.isCurrent() || !store.state[direction])
        return pending ? joinRead(pending) : Effect.void;
      restoringView = false;
      restorePending = false;
      return jobs.run(historyJob, readPage(direction), { replace: true });
    });

  const updateView = (update: (view: TranscriptView) => TranscriptView) =>
    Effect.gen(function* () {
      // Read, updated and remembered in one step; an update that keeps the view saves nothing.
      const captured = yield* checkTranscript(() => {
        const current = store.state.view,
          view = update(current);
        return view === current ? null : store.rememberView(view);
      });
      if (!captured) return;
      // Saving a view the reader scrolled to stops counting a running restore as one.
      const restoring = restoringView;
      restoringView = false;
      restorePending = false;
      // No anchor, or a live-edge row, follows once history reaches the newest entry.
      history.following =
        (!captured.anchor || isLiveRowKey(captured.anchor.key)) && !history.hasLater();
      yield* store.update((state) => ({
        ...state,
        view: captured,
        loading: restoring ? false : state.loading,
      }));
      if (restoring) yield* interruptHistory;
    });
  const setView = (view: TranscriptView) => updateView(() => view);
  /**
   * Shows `entryId`, reading history around it unless it is retained. The list places it afresh,
   * at its top; a jump to the saved anchor's entry while it isn't retained (Retry after a restore
   * failed) keeps the saved offset. A restore (`resetView` false) leaves the view as remembered.
   */
  const jumpTo = (entryId: string, resetView: boolean) =>
    Effect.gen(function* () {
      if (resetView) {
        restorePending = false;
        restoringView = false;
        yield* options.cancelFindReveal;
      }
      history.following = false;
      const key = getEntryRowKey(entryId),
        saved = store.state.view.anchor;
      const offset = saved?.key === key && !history.findRecord(entryId) ? saved.offset : 0;
      const work = Effect.gen(function* () {
        if (!history.findRecord(entryId)) yield* readAround(entryId, undefined, 'earlier', true);
        else if (resetView) history.dataset++;
        if (resetView)
          yield* setView({ anchor: { key, offset }, expanded: store.state.view.expanded });
      });
      yield* jobs.run(historyJob, work, { replace: true });
    });

  return {
    restoreView: Effect.suspend(() => {
      if (!restorePending) return Effect.void;
      restorePending = false;
      const anchor = store.state.view.anchor;
      // View memory is a location hint; a live row is at the live edge the history follows.
      const entryId = anchor && findRowEntryId(anchor.key);
      if (!entryId) return Effect.void;
      restoringView = true;
      return jumpTo(entryId, false).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            restoringView = false;
          }),
        ),
      );
    }),
    showEarlier: move('earlier'),
    showLater: move('later'),
    jumpToEntry: (entryId) => jumpTo(entryId, true),
    /** Follows the live edge again, reading the latest snapshot only when history has a gap. */
    jumpToLatest: Effect.gen(function* () {
      restoringView = false;
      yield* options.cancelFindReveal;
      restorePending = false;
      const work = Effect.gen(function* () {
        const expanded = store.state.view.expanded;
        if (!history.hasLater()) {
          history.following = true;
          const view = store.rememberView({ anchor: null, expanded });
          return yield* store.update((state) => ({ ...state, view }), 'later');
        }
        const previous = store.state.snapshot;
        const snapshot = yield* chat.getChat({ target });
        history.resetToLatest();
        const view = store.rememberView({ anchor: null, expanded });
        yield* store.update((state) => ({ ...state, view }));
        // A watch received during this explicit read wins its coherent live boundary.
        const watched = store.state.snapshot;
        yield* options.acceptSnapshot(watched !== previous && watched ? watched : snapshot);
      });
      yield* jobs.run(historyJob, work, { replace: true });
    }),
    setView,
    updateView,
    revealEntry: (entryId) =>
      Effect.gen(function* () {
        restoringView = false;
        history.following = false;
        restorePending = false;
        yield* interruptHistory;
        if (!history.findRecord(entryId)) yield* readAround(entryId, undefined, 'earlier', true);
        yield* setView({
          anchor: { key: getEntryRowKey(entryId), offset: 0 },
          expanded: store.state.view.expanded,
        });
      }),
  };
}
