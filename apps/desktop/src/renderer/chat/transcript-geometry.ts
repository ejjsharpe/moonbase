import { createContext, type RefObject } from 'react';
import type { LegendListRef } from '@legendapp/list/react';

/** The transcript's scrolling element, for rows that reveal content inside it. */
export const TranscriptScroller = createContext<RefObject<HTMLElement | null>>({ current: null });
/** Pixels kept above a revealed match. */
const revealMargin = 24;
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
