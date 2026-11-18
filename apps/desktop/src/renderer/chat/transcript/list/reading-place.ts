import {
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  type RefObject,
} from 'react';
import { RegistryContext } from '@effect/atom-react';
import type { LegendListRef } from '@legendapp/list/react';
import type { TranscriptViewAnchor } from '@moonbase/application/chat';
import { useTranscript } from '../transcript-context.ts';

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

/**
 * Places each dataset where the reader was. The list places the anchor's item at the anchor's
 * offset; the anchor's offset is from its row, which may sit lower in the item (a card), so once
 * placed the row moves to its own offset. Rows above it in the card can still grow as they render,
 * and an earlier page can join rows to the card's start (the list holds the card's top, not the
 * row), so the row is held there until the reader's first input or a Find reveal. A dataset with
 * no anchor settles on its end.
 */
export function useReadingPlace({
  list,
  ready,
  dataset,
  anchor,
  findRevealing,
  items,
}: {
  list: RefObject<LegendListRef | null>;
  /** The list placed `dataset`. */
  ready: boolean;
  dataset: number;
  /** Where the dataset opens: its saved anchor, when its row is retained. */
  anchor: TranscriptViewAnchor | null;
  findRevealing: boolean;
  /** The list's items, which can move the held row as they change. */
  items: unknown;
}) {
  const { view } = useTranscript();
  const registry = useContext(RegistryContext);
  const readDataset = () => registry.get(view.transcript).dataset;
  /** The dataset last placed, and the restored anchor held in place until the reader moves. */
  const placed = useRef<number | null>(null),
    held = useRef<{ dataset: number; anchor: TranscriptViewAnchor } | null>(null),
    holdFrame = useRef(0);
  const holdAnchor = useEffectEvent(() => {
    cancelAnimationFrame(holdFrame.current);
    let frames = 0;
    const hold = () => {
      const ref = list.current,
        node = ref?.getScrollableNode(),
        target = held.current;
      if (!ref || !node || !target || readDataset() !== target.dataset) return;
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
  });
  /**
   * Settles a dataset that opens at its end on the end as the page measures it. The list scrolls
   * there from estimated row sizes and corrects itself only after a fallback delay, so it would
   * rest short of the end meanwhile. Done once the end holds for two frames; a streaming reply
   * moves it every frame, so after a second the list's own following carries on. A jump or
   * restore replacing the dataset meanwhile opens at its own place, so settling stops there.
   */
  const settleEnd = useEffectEvent(() => {
    cancelAnimationFrame(holdFrame.current);
    const settling = readDataset();
    let frames = 0,
      still = 0;
    const settle = () => {
      const ref = list.current,
        node = ref?.getScrollableNode();
      if (!ref || !node || readDataset() !== settling) return;
      const end = node.scrollHeight - node.clientHeight;
      if (Math.abs(end - node.scrollTop) >= 1) {
        still = 0;
        void ref.scrollToOffset({ offset: end, animated: false });
      } else if (++still >= 2) return;
      if (++frames < 60) holdFrame.current = requestAnimationFrame(settle);
    };
    settle();
  });
  /** The reader's own scroll, press or key ends the hold. */
  const releasePlace = useCallback(() => {
    held.current = null;
    cancelAnimationFrame(holdFrame.current);
  }, []);
  useLayoutEffect(() => {
    const ref = list.current;
    if (!ref || !ready || placed.current === dataset) return;
    placed.current = dataset;
    releasePlace();
    if (!anchor && !findRevealing) {
      settleEnd();
      return;
    }
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
  }, [list, ready, dataset, anchor, findRevealing, releasePlace]);
  // Rows joining the anchor's card (an earlier page) move the row; hold it again.
  useLayoutEffect(() => {
    if (held.current) holdAnchor();
  }, [items]);
  useLayoutEffect(() => {
    if (findRevealing) releasePlace();
  }, [findRevealing, releasePlace]);
  useEffect(() => () => cancelAnimationFrame(holdFrame.current), []);
  return {
    /** Whether a restored anchor is held in place, which is then where the reader is. */
    holding: () => held.current !== null,
    releasePlace,
  };
}
