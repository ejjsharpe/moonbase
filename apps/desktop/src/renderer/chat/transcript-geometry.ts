import { createContext, type RefObject } from 'react';
import type { LegendListRef } from '@legendapp/list/react';
import type { TranscriptViewAnchor } from '@moonbase/application/chat';

/** The transcript's scrolling element, for rows that reveal content inside it. */
export const TranscriptScroller = createContext<RefObject<HTMLElement | null>>({ current: null });
/** Pixels kept above a revealed match. */
const revealMargin = 24;
/** Parts an anchor may name. A folded part is skipped: an anchor in a part reveals it. */
const anchorPartSelector = '[data-transcript-part]:not([data-transcript-folded])';

const findRow = (scroller: HTMLElement, key: string) =>
  scroller.querySelector<HTMLElement>(`[data-transcript-row="${CSS.escape(key)}"]`);

/**
 * Refines the first visible row (from the list) to the first visible part inside it: the anchor
 * names that part and its offset from the scroller's top, or the row's own offset.
 */
export function findReadingAnchor(scroller: HTMLElement, key: string): TranscriptViewAnchor | null {
  const row = findRow(scroller, key);
  if (!row) return null;
  const top = scroller.getBoundingClientRect().top;
  const part = [...row.querySelectorAll<HTMLElement>(anchorPartSelector)].find(
    (node) => node.getBoundingClientRect().bottom > top,
  );
  if (part?.dataset.transcriptPart)
    return {
      key,
      partId: part.dataset.transcriptPart,
      offset: part.getBoundingClientRect().top - top,
    };
  return { key, offset: row.getBoundingClientRect().top - top };
}

/**
 * How far the anchor's part (or row) is from the anchor's offset, or null while its row isn't
 * mounted. A part hidden in folded activity is measured by its activity.
 */
function measureAnchorDelta(scroller: HTMLElement, anchor: TranscriptViewAnchor) {
  const row = findRow(scroller, anchor.key);
  if (!row) return null;
  let target: HTMLElement = row;
  const part =
    anchor.partId &&
    [...row.querySelectorAll<HTMLElement>('[data-transcript-part]')].find(
      (node) => node.dataset.transcriptPart === anchor.partId,
    );
  if (part)
    target = part.getClientRects().length
      ? part
      : (part.closest<HTMLElement>('[data-transcript-activity]') ?? row);
  return target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
}
/**
 * Whether the anchor's part (or row) is at the anchor's offset, or as near as the scroll range
 * allows: an anchor near the end can't scroll to the top.
 */
export function isAnchorHeld(scroller: HTMLElement, anchor: TranscriptViewAnchor) {
  const delta = measureAnchorDelta(scroller, anchor);
  if (delta === null) return false;
  const bottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 1;
  return Math.abs(delta) < 1 || (delta > 0 && bottom) || (delta < 0 && scroller.scrollTop < 1);
}
/** Once the anchor's row is mounted, moves its part (or the row) to the anchor's offset. */
export function applyPartOffset(list: LegendListRef, anchor: TranscriptViewAnchor) {
  const scroller = list.getScrollableNode();
  const delta = scroller && measureAnchorDelta(scroller, anchor);
  // The list's own offsets exclude its header; the scroller's position is the one measured here.
  if (scroller && delta && Math.abs(delta) >= 0.5) scroller.scrollTop += delta;
}

/**
 * Moves only the transcript and scrolling output inside it to `target`, keeping the Find field
 * and the reader's selection/focus intact.
 */
export function scrollToReading(target: Range | HTMLElement, scroller: HTMLElement | null) {
  const start = target instanceof Range ? target.startContainer.parentElement : target;
  if (!scroller || !start || !scroller.contains(start)) return;
  for (
    let element: HTMLElement | null = start;
    element && element !== scroller;
    element = element.parentElement
  ) {
    if (!/auto|scroll/.test(getComputedStyle(element).overflow)) continue;
    const box = element.getBoundingClientRect(),
      rect = target.getBoundingClientRect();
    element.scrollLeft += rect.left - box.left - element.clientWidth / 2;
    element.scrollTop += rect.top - box.top - element.clientHeight / 2;
  }
  scroller.scrollTop +=
    target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - revealMargin;
}

/** Reveals the active Find match where it is painted, or its original-source excerpt. */
export function revealFindMatch(list: LegendListRef) {
  const scroller = list.getScrollableNode();
  if (!scroller) return;
  let target: Range | HTMLElement | null = null;
  for (const range of CSS.highlights.get('find-active') ?? [])
    if (range instanceof Range && scroller.contains(range.startContainer)) target ??= range;
  target ??= scroller.querySelector<HTMLElement>('[data-transcript-find-match]');
  if (target) scrollToReading(target, scroller);
}
