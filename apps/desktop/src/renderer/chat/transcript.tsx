import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { Button } from '@base-ui/react/button';
import {
  LegendList,
  type LegendListRef,
  type LegendListRenderItemProps,
} from '@legendapp/list/react';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import {
  findRowEntryId,
  getEntryRowKey,
  type ChatController,
  type ChatState,
  type TranscriptRow,
  type TranscriptViewAnchor,
} from '@moonbase/application/chat';
import type {
  ChatEntry,
  ChatRun,
  ChatToolActivity,
  ChatTranscriptMatch,
  ChatTranscriptSource,
} from '@moonbase/contracts/chat';
import { areJsonValuesEqual } from '@moonbase/contracts/common';
import type { TranscriptNative } from '../../chat/wire.ts';
import { MarkdownCache } from './markdown-model.ts';
import {
  collectActivityEvidence,
  getEntryTranscripts,
  classifyEntry,
  describeActivityHeadline,
  getActivityStepState,
  groupActivitySteps,
  findReadingAnchor,
  getAnsweredCall,
  groupTranscriptRows,
  isSameActivityEvidence,
  type ActivityEvidence,
  type ActivityHeadline,
  type TranscriptItem,
} from './activity.ts';
import { StoredImages } from './stored-image.tsx';
import { getTranscriptParts } from './transcript-parts.ts';
import { isReadingNodePinned, subscribeReadingChanges } from './reading-pin.ts';
import { ActivityGroupLine, Entry, type EntryProps } from './transcript-entry.tsx';
import {
  createOpenCalls,
  OpenCallsContext,
  useFoldedFindMatch,
  useRememberedFold,
  useRetainedCalls,
} from './transcript-disclosure.ts';
import { useTranscriptActions } from './transcript-actions.ts';
import { groupBySource } from './stable-props.ts';
import { TranscriptScroller, revealFindMatch } from './transcript-geometry.ts';
import { createViewSaver, type ViewSaver } from './transcript-view-saving.ts';
import { holdTranscriptSelection } from './transcript-selection.ts';
import { holdPlaceWhileFocusMoves } from './transcript-focus.ts';
import { transcriptStyles as styles } from './transcript-styles.ts';

/** Pixels between rows (`space.xl`); the list needs a number to lay rows out. */
const rowGap = 24;
/**
 * A first-render hint from the demo's measured rows (answers about 200–250px, questions about
 * 100px); once rows render the list uses each row type's measured average.
 */
const estimatedRowSize = 200;
/**
 * Following keeps the end visible through every change: rows appending and growing, and the
 * oldest rows evicted as new ones arrive at the record budget (not a pure append).
 */
const following = { animated: false } as const;
/** Following while the reader opens something: new rows still follow, growing rows don't. */
const followingNewRows = {
  animated: false,
  on: { dataAppend: true, dataChange: true, footerLayout: true, layout: true },
} as const;
/** Holds the reader's position through prepends, far-end evictions and disclosure toggles. */
const keepPosition = { data: true, size: true } as const;
type Paging = 'earlier' | 'later' | 'latest';

export function Transcript({
  controller,
  state: latestState,
  native,
}: {
  controller: ChatController;
  state: ChatState;
  native?: TranscriptNative;
  /** The open Find bar's field. */
}) {
  const list = useRef<LegendListRef | null>(null);
  const scroller = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        return list.current?.getScrollableNode() ?? null;
      },
    }),
    [],
  );
  const reading = useReadingRows(scroller);
  const [imageSource, setImageSource] = useState<ChatTranscriptSource | null>(null);
  const [presented, setPresented] = useState(latestState);
  // A selection in the live response holds it while the run that produced it is replaced.
  const preserve = reading.live && getLiveIdentity(presented) !== getLiveIdentity(latestState);
  if (!preserve && presented !== latestState) setPresented(latestState);
  const state = preserve ? presented : latestState;
  const current = useRef(state);
  useLayoutEffect(() => {
    current.current = state;
  }, [state]);
  const [views] = useState(() => createViewSaver(controller, readDevicePixel));
  const { notice, actions } = useTranscriptActions(native, latestState);
  const [cache] = useState(() => new MarkdownCache());
  useEffect(() => () => cache.clear(), [cache]);
  const [paging, setPaging] = useState<Paging | null>(null);
  /** The last history read, which Retry repeats. */
  const [lastPaging, setLastPaging] = useState<Paging>('earlier');
  const page = useCallback(
    (direction: Paging) => {
      const { transcript } = current.current;
      if (direction !== 'latest' && (!transcript[direction] || transcript.loading)) return;
      setLastPaging(direction);
      setPaging(direction);
      const read = {
        earlier: () => controller.showEarlier(),
        later: () => controller.showLater(),
        latest: () => controller.jumpToLatest(),
      }[direction]();
      void read.finally(() => {
        setPaging(null);
        if (direction === 'latest') void list.current?.scrollToEnd({ animated: false });
      });
    },
    [controller],
  );
  /** The reader opened something while following; see TranscriptList's holdDisclosure. */
  const [holding, setHolding] = useState(false);
  const jumpToLatest = () => {
    setHolding(false);
    const selection = window.getSelection(),
      node = scroller.current;
    if (node && selection?.rangeCount && selection.getRangeAt(0).intersectsNode(node))
      selection.removeAllRanges();
    page('latest');
  };

  const status = latestState.transcript;
  const currentSnapshot = latestState.snapshot;
  const { transcript, snapshot } = state;
  const rows = transcript.rows;
  const liveTranscript = rows.findLast((row) => row.kind === 'live')?.entry.transcript;
  const stored = useMemo(
    () => getEntryTranscripts(transcript.entries, transcript.manifest),
    [transcript.entries, transcript.manifest],
  );
  const collected = useMemo(
    () =>
      collectActivityEvidence([
        ...stored,
        ...(liveTranscript
          ? [{ ...liveTranscript, parts: getTranscriptParts(liveTranscript, transcript.manifest) }]
          : []),
      ]),
    [stored, liveTranscript, transcript.manifest],
  );
  // Streaming rebuilds the evidence each frame; rows keep it while its states are unchanged.
  const [evidence, setEvidence] = useState(collected);
  if (evidence !== collected && !isSameActivityEvidence(evidence, collected))
    setEvidence(collected);
  let liveLabel: string | undefined;
  if (currentSnapshot && currentSnapshot.state !== 'running')
    liveLabel = snapshotLabels[currentSnapshot.state];
  if (preserve) liveLabel = 'Selected response';
  const getRowProps = useRowProps(transcript);
  // Seeded with the retained entries, so output rows render as such from the first frame.
  const [openCalls] = useState(() => createOpenCalls(transcript.entries.map((entry) => entry.id)));
  useLayoutEffect(
    () => openCalls.setRetained(transcript.entries.map((entry) => entry.id)),
    [openCalls, transcript.entries],
  );
  const rowContext = useMemo(
    () => ({
      shared: { controller, cache, native, actions, evidence },
      getRowProps,
      liveLabel,
    }),
    [controller, cache, native, actions, evidence, getRowProps, liveLabel],
  );
  const mounted = useMountedRowKeys(rows, reading, imageSource, transcript.find.active);
  const failed = currentSnapshot && ['failed', 'uncertain'].includes(currentSnapshot.state);
  const [followingEnd, setFollowingEnd] = useState(true);
  /** Reads the saved view's missing anchor again, or repeats the last history read. */
  const retry = () => {
    // Retry is the reader's move, so it ends a held Find reveal; automatic paging leaves it.
    controller.cancelFindReveal();
    const anchor = transcript.view.anchor;
    const missing = anchor && findRowEntryId(anchor.key);
    if (missing && !rows.some((row) => row.key === anchor!.key))
      void controller.jumpToEntry(missing);
    else page(lastPaging);
  };

  const body = (
    <section aria-label="Chat conversation" {...stylex.props(styles.transcript)}>
      <div {...stylex.props(styles.row)}>
        <div {...stylex.props(styles.measure)}>
          {!snapshot && (
            <p>
              {state.ready
                ? 'Reading the saved chat…'
                : 'This view is offline. Its draft and unresolved command identities are retained.'}
            </p>
          )}
          {/* Idle and running need no line; stopped and failed say so. */}
          {currentSnapshot && !['idle', 'running'].includes(currentSnapshot.state) && (
            <p
              aria-label="Conversation status"
              role={failed ? 'alert' : 'status'}
              {...stylex.props(failed ? styles.warning : styles.small, styles.feedback)}>
              {snapshotLabels[currentSnapshot.state]}
              {currentSnapshot.message && ` · ${currentSnapshot.message}`}
            </p>
          )}
          {notice && (
            <p
              role={notice.tone === 'error' ? 'alert' : 'status'}
              {...stylex.props(
                notice.tone === 'error' ? styles.warning : styles.small,
                styles.feedback,
              )}>
              {notice.text}
            </p>
          )}
          {status.error && (
            <p role="alert" {...stylex.props(styles.warning)}>
              {status.error}{' '}
              <Button {...stylex.props(controls.button)} onClick={retry}>
                Retry history
              </Button>
            </p>
          )}
          {status.observation === 'reconnecting' && (
            <p role="status" {...stylex.props(styles.small)}>
              Reconnecting. Showing the last received content; live reads and Copy wait for a fresh
              connection.
            </p>
          )}
          {status.observation === 'failed' && (
            <p role="alert" {...stylex.props(styles.warning)}>
              Live updates stopped. Reopen the conversation to refresh.
            </p>
          )}
          {status.observation === 'legacy' && (
            <p {...stylex.props(styles.small)}>
              This host updates periodically. Upgrade the host for streaming responses.
            </p>
          )}
          {status.capabilities.transcript === 'legacy' && (
            <p {...stylex.props(styles.small)}>
              Upgrade this host for complete transcript reads and Copy. Previews remain readable.
            </p>
          )}
          {preserve && (
            <p role="status" {...stylex.props(styles.small)}>
              The response changed. Your selection is retained; Jump to latest to read the current
              output.
            </p>
          )}
        </div>
      </div>
      <div {...stylex.props(styles.viewport)}>
        {snapshot && (
          <RowContext.Provider value={rowContext}>
            <OpenCallsContext.Provider value={openCalls}>
              <TranscriptList
                list={list}
                transcript={transcript}
                views={views}
                mounted={mounted}
                selecting={reading.selecting}
                onFollowingChange={setFollowingEnd}
                holding={holding}
                onHoldingChange={setHolding}
                onPage={page}
                onReaderInput={controller.cancelFindReveal}
                header={
                  <Edge>
                    {paging === 'earlier' && (
                      <p role="status" {...stylex.props(styles.small)}>
                        Loading earlier…
                      </p>
                    )}
                    {!transcript.earlier && (
                      <p {...stylex.props(styles.small)}>Start of conversation</p>
                    )}
                  </Edge>
                }
                footer={
                  <Edge>
                    {(paging === 'later' || (transcript.later && transcript.loading)) && (
                      <p role="status" {...stylex.props(styles.small)}>
                        Loading later…
                      </p>
                    )}
                  </Edge>
                }
              />
            </OpenCallsContext.Provider>
          </RowContext.Provider>
        )}
        {snapshot && (!followingEnd || transcript.later || preserve) && (
          <Button
            {...stylex.props(controls.button, styles.jump)}
            disabled={paging === 'latest'}
            onClick={jumpToLatest}>
            Jump to latest
          </Button>
        )}
      </div>
    </section>
  );
  return (
    <TranscriptScroller.Provider value={scroller}>
      <StoredImages
        native={native}
        enabled={
          latestState.ready &&
          !['inactive', 'reconnecting', 'failed'].includes(latestState.transcript.observation)
        }
        fallback={scroller}
        onReadingSourceChange={setImageSource}>
        {body}
      </StoredImages>
    </TranscriptScroller.Provider>
  );
}

/**
 * The retained rows. When the application replaces them or jumps (`dataset`), the list keeps its
 * DOM and measured sizes but places the dataset afresh (`dataKey`): at its saved anchor, or the
 * end. Otherwise the anchor is only what the list reports back.
 */
function TranscriptList({
  list,
  transcript,
  views,
  mounted,
  selecting,
  onFollowingChange,
  holding,
  onHoldingChange: setHolding,
  onPage,
  onReaderInput,
  header,
  footer,
}: {
  list: RefObject<LegendListRef | null>;
  transcript: ChatState['transcript'];
  views: ViewSaver;
  mounted: string[];
  selecting: boolean;
  onFollowingChange(following: boolean): void;
  /** Growing rows don't pin the end, after the reader opened something while following. */
  holding: boolean;
  onHoldingChange(holding: boolean): void;
  onPage(direction: Paging): void;
  /** The reader scrolled, pressed, typed or moved focus in the list. */
  onReaderInput(): void;
  header: ReactElement;
  footer: ReactElement;
}) {
  const current = useRef(transcript);
  useLayoutEffect(() => {
    current.current = transcript;
  }, [transcript]);
  const { dataset } = transcript;
  /** Whether the list last reported following the live edge, read when the rows regroup. */
  const followingEdge = useRef(true);
  // Each grouping keeps the previous items' keys.
  const [grouped, setGrouped] = useState(() => ({
    rows: transcript.rows,
    items: groupTranscriptRows(transcript.rows, kindOfRow, []),
  }));
  let items = grouped.items;
  if (grouped.rows !== transcript.rows) {
    items = groupTranscriptRows(
      transcript.rows,
      kindOfRow,
      grouped.items,
      // oxlint-disable-next-line react-hooks/refs -- the reader's place when the rows change
      followingEdge.current,
    );
    setGrouped({ rows: transcript.rows, items });
  }
  const groupStarts = useMemo(() => findGroupStarts(items), [items]);
  /** The list item holding each row: a row in an activity run is drawn by the run's item. */
  const itemKeys = useMemo(
    () => new Map(items.flatMap((item) => item.rows.map((row) => [row.key, item.key] as const))),
    [items],
  );
  const currentItemKeys = useRef(itemKeys),
    currentItems = useRef(items);
  useLayoutEffect(() => {
    currentItemKeys.current = itemKeys;
    currentItems.current = items;
  }, [itemKeys, items]);
  /** Where this dataset opens: its saved anchor's row when it has one. */
  const [placement, setPlacement] = useState(() => findPlacement(transcript, items));
  if (placement.dataset !== dataset) setPlacement(findPlacement(transcript, items));
  /** The dataset the list last finished placing; until then this one isn't ready. */
  const [readyDataset, setReadyDataset] = useState<number | null>(null);
  const ready = readyDataset === dataset;
  /** The dataset last placed, and the restored anchor held in place until the reader moves. */
  const placed = useRef<number | null>(null),
    held = useRef<{ dataset: number; anchor: TranscriptViewAnchor } | null>(null),
    holdFrame = useRef(0);
  /** Saves where the reader is once scrolling ends: the first visible row, or null following. */
  const save = useCallback(() => {
    const ref = list.current;
    const { view, rows, loading, later } = current.current;
    if (!ref || !ready) return;
    // While the list holds a restored anchor in place, that anchor is where the reader is.
    if (held.current) return;
    // A restoration still reading its anchor's history saves nothing over it.
    if (view.anchor && loading && !rows.some((row) => row.key === view.anchor!.key)) return;
    if (ref.getState().isFollowingEnd && !later) views.save(null);
    else {
      // The list reports its first visible item; the anchor names one of its stored rows.
      const visible = ref.anchorVisibleContent({ hold: false });
      const node = ref.getScrollableNode();
      const anchor =
        visible &&
        findReadingAnchor(currentItems.current, visible, {
          measure: (key) => ref.anchorVisibleContent({ key, hold: false })?.offset,
          // From where the row is on screen, so the offset reads as the restore places it.
          rowTop: (key) => {
            const item = currentItemKeys.current.get(key);
            const offset =
              item === undefined
                ? undefined
                : ref.anchorVisibleContent({ key: item, hold: false })?.offset;
            const row = node?.querySelector(`[data-transcript-row="${CSS.escape(key)}"]`);
            // A row in a folded run isn't shown, so it has no place on screen.
            return offset === undefined || !row || !row.getClientRects().length
              ? undefined
              : offset - (node!.getBoundingClientRect().top - row.getBoundingClientRect().top);
          },
        });
      if (anchor) views.save(anchor);
    }
  }, [list, views, ready]);
  useEffect(() => {
    const node = list.current?.getScrollableNode();
    node?.addEventListener('scrollend', save);
    return () => node?.removeEventListener('scrollend', save);
  }, [list, save]);
  useEffect(() => {
    const node = list.current?.getScrollableNode();
    return node
      ? holdTranscriptSelection(node, (key) =>
          current.current.rows.findIndex((row) => row.key === key),
        )
      : undefined;
  }, [list]);
  useEffect(() => {
    const node = list.current?.getScrollableNode();
    return node ? holdPlaceWhileFocusMoves(node) : undefined;
  }, [list]);
  useEffect(() => {
    const ref = list.current;
    if (!ref) return;
    // While holding, content below the screen counts as not following, so Jump to latest shows.
    const report = () => {
      const state = ref.getState();
      followingEdge.current = state.isFollowingEnd;
      onFollowingChange(state.isFollowingEnd && (!holding || state.isAtEnd));
    };
    report();
    const following = ref.getState().listen('isFollowingEnd', report),
      end = ref.getState().listen('isAtEnd', report);
    return () => {
      following();
      end();
    };
  }, [list, onFollowingChange, holding]);
  // The list placed the anchor's item at the anchor's offset; the anchor's offset is from its row,
  // which may sit lower in the item (a card), so once placed the row moves to its own offset. Rows
  // above it in the card can still grow as they render, and an earlier page can join rows to the
  // card's start (the list holds the card's top, not the row), so the row is held there until the
  // reader's first input or a Find reveal.
  const { active: findActive, revealing: findRevealing } = transcript.find;
  const holdAnchor = useCallback(() => {
    cancelAnimationFrame(holdFrame.current);
    let frames = 0;
    const hold = () => {
      const ref = list.current,
        node = ref?.getScrollableNode(),
        target = held.current;
      if (!ref || !node || !target || current.current.dataset !== target.dataset) return;
      const row = node.querySelector(`[data-transcript-row="${CSS.escape(target.anchor.key)}"]`);
      // A row a folded run hides has no place to hold.
      if (!row || !row.getClientRects().length) return;
      const moved =
        row.getBoundingClientRect().top - node.getBoundingClientRect().top + target.anchor.offset;
      if (Math.abs(moved) >= 1)
        void ref.scrollToOffset({ offset: node.scrollTop + moved, animated: false });
      if (++frames < 12) holdFrame.current = requestAnimationFrame(hold);
    };
    hold();
  }, [list]);
  /** The reader's own scroll, press or key ends the hold. */
  const releasePlace = useCallback(() => {
    held.current = null;
    cancelAnimationFrame(holdFrame.current);
  }, []);
  useLayoutEffect(() => {
    const ref = list.current,
      { anchor } = placement;
    if (!ref || !ready || placed.current === dataset) return;
    placed.current = dataset;
    releasePlace();
    // At the end the list follows it; a row that isn't mounted can't be measured.
    if (
      !anchor ||
      findRevealing ||
      ref.getState().isAtEnd ||
      readRowTop(ref.getScrollableNode(), anchor.key) === undefined
    )
      return;
    held.current = { dataset, anchor };
    holdAnchor();
  }, [list, ready, dataset, placement, findRevealing, holdAnchor, releasePlace]);
  // Rows joining the anchor's card (an earlier page) move the row; hold it again.
  useLayoutEffect(() => {
    if (held.current) holdAnchor();
  }, [items, holdAnchor]);
  useLayoutEffect(() => {
    if (findRevealing) releasePlace();
  }, [findRevealing, releasePlace]);
  useEffect(() => () => cancelAnimationFrame(holdFrame.current), []);
  // A newly revealed Find match, or one a jump just placed: scrolling to its row releases
  // following, then the match itself is revealed inside it. A match rendered later is revealed by
  // its part.
  useLayoutEffect(() => {
    const ref = list.current;
    if (!findActive || !findRevealing || !ref || !ready) return;
    void ref
      .scrollToKey({
        key:
          currentItemKeys.current.get(getEntryRowKey(findActive.source.entryId)) ??
          getEntryRowKey(findActive.source.entryId),
        animated: false,
      })
      .then(() => {
        if (current.current.dataset === dataset) revealFindMatch(ref);
      });
  }, [findActive, findRevealing, dataset, list, ready]);
  /**
   * Holds a revealing Find match in view while its row grows (its part loading or unfolding): the
   * list holds the row's top, not the match inside it. Reader input ends revealing.
   */
  const frame = useRef(0);
  const holdFindReveal = useCallback(
    ({ itemKey }: { itemKey: string }) => {
      const { active, revealing } = current.current.find;
      if (
        !revealing ||
        !active ||
        currentItemKeys.current.get(getEntryRowKey(active.source.entryId)) !== itemKey
      )
        return;
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        if (list.current && current.current.find.revealing) revealFindMatch(list.current);
      });
    },
    [list],
  );
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  // The list reports reaching an edge once; one reached while history was loading pages when
  // loading settles. A failed read waits for Retry. Paging saves where the reader is first, so
  // the application knows whether they still follow while the page reads.
  const { loading, earlier, later, error } = transcript;
  const pageEarlier = useCallback(() => {
    if (current.current.error) return;
    save();
    onPage('earlier');
  }, [onPage, save]);
  const pageLater = useCallback(() => {
    if (current.current.error) return;
    save();
    onPage('later');
  }, [onPage, save]);
  useEffect(() => {
    const state = list.current?.getState();
    if (loading || error || !state || !ready) return;
    if (earlier && state.isNearStart) pageEarlier();
    else if (later && state.isNearEnd) pageLater();
  }, [loading, error, earlier, later, list, pageEarlier, pageLater, ready]);
  const alwaysRender = useMemo(
    () => ({ keys: [...new Set(mounted.map((key) => itemKeys.get(key) ?? key))] }),
    [mounted, itemKeys],
  );
  /**
   * Opening or closing a disclosure while following the end would pin the end and push the rows
   * above it up. Pressing one stops following rows that change size, so the change grows or
   * shrinks below; new rows still follow, and the reader's next scroll ends the hold.
   */
  const holdDisclosure = (event: { target: EventTarget; key?: string }) => {
    if (event.key !== undefined && event.key !== 'Enter' && event.key !== ' ') return;
    const toggle = (event.target as Element).closest?.('button[aria-expanded]');
    if (
      toggle?.closest('[data-transcript-row], [data-transcript-run]') &&
      list.current?.getState().isFollowingEnd
    )
      setHolding(true);
  };
  return (
    <GroupStartsContext.Provider value={groupStarts}>
      <LegendList<TranscriptItem<TranscriptRow>>
        ref={list}
        role="region"
        aria-label="Chat transcript"
        data-transcript-list=""
        tabIndex={0}
        data={items}
        dataKey={dataset}
        keyExtractor={getItemKey}
        getItemType={getItemType}
        renderItem={renderItem}
        estimatedItemSize={estimatedRowSize}
        {...(placement.anchor
          ? {
              initialScrollIndex: {
                index: placement.index,
                viewOffset: -placement.anchor.offset,
              },
            }
          : { initialScrollAtEnd: true })}
        maintainScrollAtEnd={!selecting && (holding ? followingNewRows : following)}
        maintainVisibleContentPosition={keepPosition}
        alwaysRender={alwaysRender}
        // An edge with no more history has no callback: the list gates its edge callbacks on the
        // previous one, so an ignored call would hold back the other edge.
        onStartReached={earlier ? pageEarlier : undefined}
        onEndReached={later ? pageLater : undefined}
        onUserScroll={() => {
          releasePlace();
          setHolding(false);
          onReaderInput();
        }}
        onWheelCapture={releasePlace}
        onItemSizeChanged={holdFindReveal}
        onPointerDownCapture={(event) => {
          releasePlace();
          holdDisclosure(event);
          onReaderInput();
        }}
        onKeyDownCapture={(event) => {
          releasePlace();
          holdDisclosure(event);
          onReaderInput();
        }}
        onFocusCapture={onReaderInput}
        onReady={() => setReadyDataset(dataset)}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        contentContainerStyle={{ gap: rowGap }}
        {...stylex.props(styles.list)}
      />
    </GroupStartsContext.Provider>
  );
}

/** Where the saved anchor's item is in the dataset; without an anchor it opens at the end. */
function findPlacement(
  { dataset, view }: ChatState['transcript'],
  items: readonly TranscriptItem<TranscriptRow>[],
) {
  const anchor = view.anchor;
  const index = anchor
    ? items.findIndex((item) => item.rows.some((row) => row.key === anchor.key))
    : -1;
  return index >= 0 ? { dataset, anchor, index } : { dataset, anchor: null, index: -1 };
}
/**
 * A shown row's top below the first of its item's rows; undefined when it isn't mounted, or is in
 * a folded run.
 */
function readRowTop(scroller: HTMLElement | null | undefined, key: string) {
  const row = scroller?.querySelector(`[data-transcript-row="${CSS.escape(key)}"]`);
  const first = row?.parentElement?.firstElementChild;
  return row && first && row.getClientRects().length
    ? row.getBoundingClientRect().top - first.getBoundingClientRect().top
    : undefined;
}
const readDevicePixel = () => 1 / window.devicePixelRatio;
const getItemKey = (item: TranscriptItem<TranscriptRow>) => item.key;
const getItemType = (item: TranscriptItem<TranscriptRow>) => {
  if (item.rows.length > 1) return 'activity';
  const row = item.rows[0]!;
  return row.kind === 'entry' ? row.entry.role : row.kind;
};
const renderItem = ({ item }: LegendListRenderItemProps<TranscriptItem<TranscriptRow>>) => (
  <Item item={item} />
);
const kindOfRow = (row: TranscriptRow) =>
  row.kind === 'tool' ? 'message' : classifyEntry(row.entry);

type RowProps = Omit<
  EntryProps,
  'entry' | 'live' | 'liveLabel' | 'joinPrevious' | 'joinNext' | keyof SharedRowProps
>;
type SharedRowProps = Pick<EntryProps, 'controller' | 'cache' | 'native' | 'actions' | 'evidence'>;
/** What every row reads from the transcript: shared props, and its own slice of state. */
const RowContext = createContext<{
  shared: SharedRowProps;
  getRowProps(entry: ChatEntry): RowProps;
  liveLabel: string | undefined;
} | null>(null);

/**
 * A list item: one row, or a run of consecutive activity rows. A run with more than one step folds
 * behind one line; its rows stay mounted underneath so Find can reach them.
 */
function Item({ item }: { item: TranscriptItem<TranscriptRow> }) {
  const context = useContext(RowContext)!;
  const startedAt = useContext(GroupStartsContext).get(item.key);
  const entryRows = item.rows.filter((row) => row.kind !== 'tool');
  const firstEntry = entryRows[0];
  const { controller } = context.shared;
  // Remembered under both the item's key, which holds as earlier rows join the run's start, and
  // its first row's, which holds as the live response leaves the run or starts a new attempt.
  const expandedIds = firstEntry ? context.getRowProps(firstEntry.entry).expandedIds : [];
  const byItem = useRememberedFold(item.key, 'activity-run', expandedIds, controller);
  const byFirstRow = useRememberedFold(
    firstEntry?.entry.id ?? item.key,
    'activity-run',
    expandedIds,
    controller,
  );
  const fold = {
    open: byItem.open || byFirstRow.open,
    setOpen: (open: boolean) => {
      byItem.setOpen(open);
      byFirstRow.setOpen(open);
    },
  };
  // The reader's place moving into a folded run (a jump, a restored position) opens it, so the
  // place is on a shown row. A folded run's own place is its first stored row, at the run's line;
  // a live row is never a place the reader scrolls to, so a place there is a jump.
  const ownPlace = firstEntry?.kind === 'entry' ? firstEntry.key : undefined;
  const placeInside = useSyncExternalStore(controller.subscribe, () => {
    const key = controller.getSnapshot().transcript.view.anchor?.key;
    return key !== undefined && key !== ownPlace && item.rows.some((row) => row.key === key)
      ? key
      : null;
  });
  const [landed, setLanded] = useState<{ place: string | null; open: boolean }>({
    place: null,
    open: false,
  });
  if (landed.place !== placeInside)
    setLanded({ place: placeInside, open: placeInside !== null || landed.open });
  // The active Find match in the run opens it, unless the reader folded it for that match.
  const match = entryRows
    .map((row) => context.getRowProps(row.entry))
    .find((props) => props.findMatch);
  const found = useFoldedFindMatch(match?.findMatch ?? null, !!match?.findRevealing, controller);
  // A response that is only working so far is a run of one, and gets the working line too.
  const first = item.rows[0]!;
  const working =
    item.rows.length === 1 && first.kind === 'live' && kindOfRow(first) === 'activity';
  // Whether a call's row is retained decides whether its output is a step of its own.
  const isRetained = useRetainedCalls(
    entryRows.flatMap((row) =>
      (row.entry.transcript?.parts ?? []).flatMap((part) => part.call?.entryId ?? []),
    ),
  );
  const { evidence } = context.shared;
  const group = useMemo(
    () =>
      item.rows.length > 1 || working ? collectGroupSteps(item.rows, evidence, isRetained) : null,
    [item.rows, working, evidence, isRetained],
  );
  const stepsId = useId();
  const rows = (fold: boolean) =>
    item.rows.map((row, index) => (
      <Row
        key={row.key}
        row={row}
        joinPrevious={fold || index > 0}
        joinNext={index < item.rows.length - 1}
      />
    ));
  const folds = !!group && group.headlines.length >= (group.active ? 1 : 2);
  const expanded = !folds || fold.open || landed.open || found.holdsOpen;
  const toggle = () => {
    if (expanded) {
      if (found.holdsOpen) found.fold();
      // A place left inside the run would name a row it no longer shows; the run's line holds it.
      const { view } = controller.getSnapshot().transcript;
      if (firstEntry && view.anchor && view.anchor.key === placeInside)
        controller.setTranscriptView({ ...view, anchor: { key: firstEntry.key, offset: 0 } });
    }
    setLanded({ place: placeInside, open: false });
    fold.setOpen(!expanded);
  };
  // One shape whether or not the run folds, so its rows stay mounted as it starts or stops
  // folding (the live response leaving a run as its answer starts, say).
  return (
    <>
      {folds && (
        <div
          // Marks the run's line as part of its first row: the list holds the reader's place as
          // it opens, and keeps it mounted while it has focus.
          data-transcript-run={firstEntry?.key ?? item.key}
          {...stylex.props(styles.row)}>
          <div {...stylex.props(styles.measure)}>
            <section
              {...stylex.props(
                styles.activity,
                expanded ? styles.activityGroupOpen : styles.activityGroup,
              )}>
              <ActivityGroupLine
                {...group}
                {...(startedAt ? { startedAt } : {})}
                open={expanded}
                stepsId={stepsId}
                onToggle={toggle}
              />
            </section>
          </div>
        </div>
      )}
      <div id={stepsId} hidden={!expanded} {...stylex.props(folds && styles.activityGroupSteps)}>
        {rows(folds)}
      </div>
    </>
  );
}

/** Every step a run of rows shows, in order; a call's output row adds none of its own. */
function collectGroupSteps(
  rows: readonly TranscriptRow[],
  evidence: ActivityEvidence,
  /** Whether a call's row is retained; its output then belongs to the call's step. */
  isRetained: (entryId: string) => boolean,
) {
  const headlines: ActivityHeadline[] = [];
  let failed = 0,
    active = false,
    endedAt: string | undefined,
    // The last row's steps: the model message the work is on now.
    latestRow: ActivityHeadline[] = [];
  for (const row of rows) {
    if (row.kind === 'tool') continue;
    endedAt = getLaterTime(endedAt, row.entry.createdAt);
    if (!row.entry.transcript) continue;
    if (row.kind === 'live' && row.state === 'running') active = true;
    const transcript = row.entry.transcript;
    const entryId = transcript.source.kind === 'entry' ? transcript.source.entryId : undefined;
    const rowHeadlines: ActivityHeadline[] = [];
    for (const step of groupActivitySteps(transcript.parts, entryId)) {
      const call = getAnsweredCall(step);
      if (call && isRetained(call.entryId)) continue;
      const state = getActivityStepState(step, transcript, evidence);
      if (['failed', 'interrupted', 'missing-result'].includes(state ?? '')) failed++;
      // A running step keeps the clock going only in the live response (stopping or deferred
      // included); a saved step can't still be running.
      if (state === 'running' && row.kind === 'live') active = true;
      const headline = describeActivityHeadline(step, transcript, evidence);
      headlines.push(headline);
      rowHeadlines.push(headline);
    }
    if (rowHeadlines.length) latestRow = rowHeadlines;
  }
  // Now: the thought the latest message opened with, which says why; else the step itself. A
  // thought from an earlier message may be about other work, so it is never paired with this one.
  const current =
    latestRow.at(-1)?.category === 'thinking'
      ? latestRow.at(-1)
      : (latestRow.findLast((headline) => headline.category === 'thinking') ?? latestRow.at(-1));
  return {
    headlines,
    failed,
    active,
    ...(current ? { current } : {}),
    ...(endedAt ? { endedAt } : {}),
  };
}

const getLaterTime = (a: string | undefined, b: string | undefined) =>
  !a || (b && Date.parse(b) > Date.parse(a)) ? b : a;

/** Each item's start: the latest time recorded before it, where the work it shows began. */
const GroupStartsContext = createContext<ReadonlyMap<string, string>>(new Map());
function findGroupStarts(items: readonly TranscriptItem<TranscriptRow>[]) {
  const starts = new Map<string, string>();
  let last: string | undefined;
  for (const item of items) {
    if (last) starts.set(item.key, last);
    for (const row of item.rows)
      if (row.kind !== 'tool') last = getLaterTime(last, row.entry.createdAt);
  }
  return starts;
}
function Row({
  row,
  joinPrevious,
  joinNext,
}: {
  row: TranscriptRow;
  joinPrevious: boolean;
  joinNext: boolean;
}) {
  const context = useContext(RowContext)!;
  return (
    <div data-transcript-row={row.key} {...stylex.props(styles.row)}>
      <div {...stylex.props(styles.measure)}>
        {row.kind === 'tool' ? (
          <ToolPreview tool={row.tool} />
        ) : (
          <Entry
            entry={row.entry}
            live={row.kind === 'live'}
            liveLabel={
              row.kind === 'live' ? (context.liveLabel ?? getRunLabel(row.state)) : undefined
            }
            joinPrevious={joinPrevious}
            joinNext={joinNext}
            {...context.shared}
            {...context.getRowProps(row.entry)}
          />
        )}
      </div>
    </div>
  );
}
function Edge({ children }: { children: ReactNode }) {
  return (
    <div {...stylex.props(styles.row, styles.edge)}>
      <div {...stylex.props(styles.measure)}>{children}</div>
    </div>
  );
}
/** A legacy host's tool output preview, shown while its run is live. */
function ToolPreview({ tool }: { tool: ChatToolActivity }) {
  return (
    <section {...stylex.props(styles.message)}>
      <strong>
        {tool.name} · {tool.state}
      </strong>
      <pre tabIndex={0} {...stylex.props(styles.output)}>
        {tool.text}
      </pre>
      {tool.truncated && (
        <p {...stylex.props(styles.small)}>
          This host supplied a tool-output preview. Upgrade the host for complete reads.
        </p>
      )}
    </section>
  );
}

/** Slices transcript state per row, in values that keep their identity while unchanged. */
function useRowProps(transcript: ChatState['transcript']) {
  const contents = useMemo(() => groupBySource(transcript.content), [transcript.content]);
  const matches = useMemo(() => groupBySource(transcript.find.matches), [transcript.find.matches]);
  const { expanded } = transcript.view;
  const { active, revealing, query } = transcript.find;
  const { manifest, observation } = transcript;
  const offline = ['reconnecting', 'failed', 'inactive'].includes(observation);
  return useCallback(
    (entry: ChatEntry): RowProps => {
      const source = entry.transcript?.source;
      const findMatch =
        active && source && areJsonValuesEqual(active.source, source) ? active : null;
      const findMatches = matches(source);
      return {
        manifest:
          manifest && source && areJsonValuesEqual(manifest.source, source) ? manifest : null,
        findMatch,
        findRevealing: !!findMatch && revealing,
        findQuery: findMatch || findMatches.length ? query : '',
        findMatches,
        contents: contents(source),
        expandedIds: expanded,
        offline,
      };
    },
    [active, revealing, query, manifest, matches, contents, expanded, offline],
  );
}

type ReadingRows = {
  /** The rows a noncollapsed selection in the transcript starts and ends in. */
  selected: readonly [string, string] | null;
  selecting: boolean;
  focused: string | null;
  /** The reader's focus or selection is in the live response. */
  live: boolean;
};
const notReading: ReadingRows = { selected: null, selecting: false, focused: null, live: false };
/** The row a node is in; a run's line counts as its first row. */
const findRowKeyOf = (node: Node | null | undefined) => {
  const found = (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>(
    '[data-transcript-row], [data-transcript-run]',
  );
  return found?.dataset.transcriptRow ?? found?.dataset.transcriptRun ?? null;
};
/** Where the reader's selection and focus are in the transcript, updated on every change. */
function useReadingRows(scroller: RefObject<HTMLElement | null>) {
  const [reading, setReading] = useState(notReading);
  useEffect(
    () =>
      subscribeReadingChanges(() => {
        const node = scroller.current;
        const selection = window.getSelection();
        const range =
          node && selection && !selection.isCollapsed && selection.rangeCount
            ? selection.getRangeAt(0)
            : null;
        const selecting = !!node && !!range && range.intersectsNode(node);
        const start = selecting ? findRowKeyOf(range!.startContainer) : null,
          end = selecting ? findRowKeyOf(range!.endContainer) : null;
        const next: ReadingRows = {
          selected: start || end ? [start ?? end!, end ?? start!] : null,
          selecting,
          focused: node?.contains(document.activeElement)
            ? findRowKeyOf(document.activeElement)
            : null,
          live: isReadingNodePinned(
            node?.querySelector<HTMLElement>('[data-transcript-live]') ?? null,
          ),
        };
        setReading((previous) => (areJsonValuesEqual(previous, next) ? previous : next));
      }),
    [scroller],
  );
  return reading;
}

/**
 * The rows kept mounted while scrolled away: the rows a selection spans, the focused row, the
 * image viewer's row and the active Find match's row. Unmounting them would lose the reader's
 * selection or focus, the viewer's return target or the match being revealed.
 */
function useMountedRowKeys(
  rows: readonly TranscriptRow[],
  reading: ReadingRows,
  imageSource: ChatTranscriptSource | null,
  findActive: ChatTranscriptMatch | null,
) {
  const keys = new Set<string>();
  if (reading.selected) {
    const [first, last] = reading.selected
      .map((key) => rows.findIndex((row) => row.key === key))
      .sort((a, b) => a - b);
    if (first! >= 0) for (let index = first!; index <= last!; index++) keys.add(rows[index]!.key);
  }
  if (reading.focused) keys.add(reading.focused);
  if (imageSource) {
    const row = rows.find(
      (row) => row.kind !== 'tool' && areJsonValuesEqual(row.entry.transcript?.source, imageSource),
    );
    if (row) keys.add(row.key);
  }
  if (findActive) keys.add(getEntryRowKey(findActive.source.entryId));
  const joined = [...keys].join('\n');
  return useMemo(() => (joined ? joined.split('\n') : []), [joined]);
}

function getLiveIdentity(state: ChatState) {
  return JSON.stringify(
    state.snapshot?.run?.transcript?.source ?? state.snapshot?.run?.stop ?? null,
  );
}
/** A run that is simply running needs no label; its activity already shows it. */
const getRunLabel = (state: ChatRun['state']) => (state === 'running' ? undefined : state);
const snapshotLabels = {
  idle: 'Idle',
  running: 'Running',
  stopped: 'Stopped',
  failed: 'Failed',
  uncertain: 'Uncertain',
};
