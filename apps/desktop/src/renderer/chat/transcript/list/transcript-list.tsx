import {
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  type ReactElement,
  type RefObject,
} from 'react';
import {
  LegendList,
  type LegendListRef,
  type LegendListRenderItemProps,
} from '@legendapp/list/react';
import * as stylex from '@stylexjs/stylex';
import { RegistryContext, useAtomValue } from '@effect/atom-react';
import { space } from '@moonbase/ui/tokens.stylex';
import type { TranscriptRow } from '@moonbase/application/chat';
import { TranscriptItemView } from '../row/transcript-item.tsx';
import { useTranscript } from '../transcript-context.ts';
import { holdPlaceWhileFocusMoves } from './focus-hold.ts';
import { useFindReveal } from './find-reveal.ts';
import { findPlacement, getItemKey, getItemType, type TranscriptItem } from './list-items.ts';
import { useReadingPlace } from './reading-place.ts';
import { holdTranscriptSelection } from './selection-hold.ts';
import { useViewSaving } from './view-saving.ts';

/**
 * A first-render hint from the demo's measured items (answers about 200–250px, questions about
 * 100px, each with the 16px space below it); once rows render the list uses each row type's
 * measured average.
 */
const estimatedRowSize = 216;
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

/**
 * The retained rows. When the application replaces them or jumps (`dataset`), the list keeps its
 * DOM and measured sizes but places the dataset afresh (`dataKey`): at its saved anchor, or the
 * end. Otherwise the anchor is only what the list reports back.
 */
export function TranscriptList({
  list,
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
  /** Rows kept mounted while scrolled away. */
  mounted: readonly string[];
  selecting: boolean;
  onFollowingChange(following: boolean): void;
  /** Growing rows don't pin the end, after the reader opened something while following. */
  holding: boolean;
  onHoldingChange(holding: boolean): void;
  onPage(direction: 'earlier' | 'later'): void;
  /** The reader scrolled, pressed, typed or moved focus in the list. */
  onReaderInput(): void;
  header: ReactElement;
  footer: ReactElement;
}) {
  const { view } = useTranscript();
  const registry = useContext(RegistryContext);
  const transcript = useAtomValue(view.transcript);
  const items = useAtomValue(view.items);
  const itemKeys = useAtomValue(view.itemKeys);
  const { dataset, loading, earlier, later, error } = transcript;
  /** Where this dataset opens: its saved anchor's row when it has one. */
  const [placement, setPlacement] = useState(() => findPlacement(transcript, items));
  if (placement.dataset !== dataset) setPlacement(findPlacement(transcript, items));
  /** The dataset the list last finished placing; until then this one isn't ready. */
  const [readyDataset, setReadyDataset] = useState<number | null>(null);
  const ready = readyDataset === dataset;
  const { active: findActive, revealing: findRevealing } = transcript.find;
  const place = useReadingPlace({
    list,
    ready,
    dataset,
    anchor: placement.anchor,
    findRevealing,
    items,
  });
  const save = useViewSaving({ list, ready, holding: place.holding });
  const holdFindReveal = useFindReveal({
    list,
    ready,
    dataset,
    match: findActive,
    revealing: findRevealing,
  });
  useEffect(() => {
    const node = list.current?.getScrollableNode();
    if (!node) return;
    const releaseSelection = holdTranscriptSelection(node, (key) =>
      registry.get(view.transcript).rows.findIndex((row) => row.key === key),
    );
    const releaseFocus = holdPlaceWhileFocusMoves(node);
    return () => {
      releaseSelection();
      releaseFocus();
    };
  }, [list, registry, view]);
  useEffect(() => {
    const ref = list.current;
    if (!ref) return;
    // While holding, content below the screen counts as not following, so Jump to latest shows.
    const report = () => {
      const state = ref.getState();
      registry.set(view.followingEdge, state.isFollowingEnd);
      onFollowingChange(state.isFollowingEnd && (!holding || state.isAtEnd));
    };
    report();
    const stopFollowing = ref.getState().listen('isFollowingEnd', report),
      stopEnd = ref.getState().listen('isAtEnd', report);
    return () => {
      stopFollowing();
      stopEnd();
    };
  }, [list, registry, view, onFollowingChange, holding]);
  // The list reports reaching an edge once; one reached while history was loading pages when
  // loading settles. A failed read waits for Retry. Paging saves where the reader is first, so
  // the application knows whether they still follow while the page reads.
  const page = (direction: 'earlier' | 'later') => {
    if (registry.get(view.transcript).error) return;
    save();
    onPage(direction);
  };
  const pageAtEdge = useEffectEvent((direction: 'earlier' | 'later') => page(direction));
  useEffect(() => {
    const state = list.current?.getState();
    if (loading || error || !state || !ready) return;
    if (earlier && state.isNearStart) pageAtEdge('earlier');
    else if (later && state.isNearEnd) pageAtEdge('later');
  }, [loading, error, earlier, later, list, ready]);
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
      onStartReached={earlier ? () => page('earlier') : undefined}
      onEndReached={later ? () => page('later') : undefined}
      onUserScroll={() => {
        place.releasePlace();
        setHolding(false);
        onReaderInput();
      }}
      onWheelCapture={place.releasePlace}
      onItemSizeChanged={holdFindReveal}
      onPointerDownCapture={(event) => {
        place.releasePlace();
        holdDisclosure(event);
        onReaderInput();
      }}
      onKeyDownCapture={(event) => {
        place.releasePlace();
        holdDisclosure(event);
        onReaderInput();
      }}
      onFocusCapture={onReaderInput}
      onReady={() => setReadyDataset(dataset)}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      {...stylex.props(styles.list)}
    />
  );
}

/**
 * Each item carries the space below it. Legend List's own `gap` stays under the last item in the
 * page but not in the length the list scrolls by, so following would stop a gap short of the end.
 */
const renderItem = ({ item }: LegendListRenderItemProps<TranscriptItem<TranscriptRow>>) => (
  <div {...stylex.props(styles.item)}>
    <TranscriptItemView item={item} />
  </div>
);

const styles = stylex.create({
  list: { flex: 1, minHeight: 0, minWidth: 0, outline: 'none' },
  /** A list item: rows sit `space.lg` apart. */
  item: { paddingBottom: space.lg },
});
