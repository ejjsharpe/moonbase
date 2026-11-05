import { createContext, type RefObject } from 'react';

/** The transcript's scrolling element, for rows that reveal content inside it. */
export const TranscriptScroller = createContext<RefObject<HTMLElement | null>>({ current: null });

/** Pixels kept above a revealed match. */
const revealMargin = 24;

/** The top of the readable area: below the scroller's top and its sticky chrome. */
export function getReadingTop(element: HTMLElement) {
  return Math.max(
    element.getBoundingClientRect().top,
    element.querySelector<HTMLElement>('[data-transcript-chrome]')?.getBoundingClientRect()
      .bottom ?? 0,
  );
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
  scroller.scrollTop += target.getBoundingClientRect().top - getReadingTop(scroller) - revealMargin;
}
