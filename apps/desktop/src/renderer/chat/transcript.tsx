import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
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
} from '@moonbase/application/chat';
import type {
  ChatEntry,
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
  groupTranscriptRows,
  isSameActivityEvidence,
  type TranscriptItem,
} from './activity.ts';
import { StoredImages } from './stored-image.tsx';
import { getTranscriptParts } from './transcript-parts.ts';
import { isReadingNodePinned, subscribeReadingChanges } from './reading-pin.ts';
import { Entry, type EntryProps } from './transcript-entry.tsx';
import { createOpenCalls, OpenCallsContext } from './transcript-disclosure.ts';
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
  const [openCalls] = useState(createOpenCalls);
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
          {/* Idle needs no line; running, stopped and failed say so. */}
          {currentSnapshot && currentSnapshot.state !== 'idle' && (
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
  const items = useMemo(
    () => groupTranscriptRows(transcript.rows, kindOfRow, itemCache),
    [transcript.rows],
  );
  /** The list item holding each row: a row in an activity run is drawn by the run's item. */
  const itemKeys = useMemo(
    () => new Map(items.flatMap((item) => item.rows.map((row) => [row.key, item.key] as const))),
    [items],
  );
  const currentItemKeys = useRef(itemKeys);
  useLayoutEffect(() => {
    currentItemKeys.current = itemKeys;
  }, [itemKeys]);
  /** Where this dataset opens: its saved anchor's row when it has one. */
  const [placement, setPlacement] = useState(() => findPlacement(transcript, items));
  if (placement.dataset !== dataset) setPlacement(findPlacement(transcript, items));
  /** The dataset the list last finished placing; until then this one isn't ready. */
  const [readyDataset, setReadyDataset] = useState<number | null>(null);
  const ready = readyDataset === dataset;
  /** Saves where the reader is once scrolling ends: the first visible row, or null following. */
  const save = useCallback(() => {
    const ref = list.current;
    const { view, rows, loading, later } = current.current;
    if (!ref || !ready) return;
    // A restoration still reading its anchor's history saves nothing over it.
    if (view.anchor && loading && !rows.some((row) => row.key === view.anchor!.key)) return;
    if (ref.getState().isFollowingEnd && !later) views.save(null);
    else {
      const anchor = ref.anchorVisibleContent({ hold: false });
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
  // A newly revealed Find match, or one a jump just placed: scrolling to its row releases
  // following, then the match itself is revealed inside it. A match rendered later is revealed by
  // its part.
  const { active: findActive, revealing: findRevealing } = transcript.find;
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
    if (toggle?.closest('[data-transcript-row]') && list.current?.getState().isFollowingEnd)
      setHolding(true);
  };
  return (
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
        setHolding(false);
        onReaderInput();
      }}
      onItemSizeChanged={holdFindReveal}
      onPointerDownCapture={(event) => {
        holdDisclosure(event);
        onReaderInput();
      }}
      onKeyDownCapture={(event) => {
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
const itemCache = new WeakMap<TranscriptRow, TranscriptItem<TranscriptRow>>();
const kindOfRow = (row: TranscriptRow) =>
  row.kind === 'tool' ? 'message' : classifyEntry(row.entry);

type RowProps = Omit<
  EntryProps,
  'entry' | 'liveState' | 'joinPrevious' | 'joinNext' | keyof SharedRowProps
>;
type SharedRowProps = Pick<EntryProps, 'controller' | 'cache' | 'native' | 'actions' | 'evidence'>;
/** What every row reads from the transcript: shared props, and its own slice of state. */
const RowContext = createContext<{
  shared: SharedRowProps;
  getRowProps(entry: ChatEntry): RowProps;
  liveLabel: string | undefined;
} | null>(null);

/** A list item: one row, or a run of activity rows drawn as one card. */
function Item({ item }: { item: TranscriptItem<TranscriptRow> }) {
  return item.rows.map((row, index) => (
    <Row key={row.key} row={row} joinPrevious={index > 0} joinNext={index < item.rows.length - 1} />
  ));
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
            liveState={row.kind === 'live' ? (context.liveLabel ?? row.state) : undefined}
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
const findRowKeyOf = (node: Node | null | undefined) =>
  (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>(
    '[data-transcript-row]',
  )?.dataset.transcriptRow ?? null;
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
const snapshotLabels = {
  idle: 'Idle',
  running: 'Running',
  stopped: 'Stopped',
  failed: 'Failed',
  uncertain: 'Uncertain',
};
