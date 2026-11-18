/**
 * Keeps the reader's place in the transcript when the list moves the row container holding focus.
 * The list reorders containers into index order after scrolling settles, and Chromium scrolls a
 * moved focused element back into view, so a reader who pressed a control and then scrolled away
 * was pulled back to it. Scroll events report each place the reader or the list scrolled to; a move
 * of the focused row that changes the scroll position before its scroll event is undone, before
 * paint. Returns the cleanup.
 */
export function holdPlaceWhileFocusMoves(scroller: HTMLElement) {
  let place = { top: scroller.scrollTop, left: scroller.scrollLeft };
  const record = () => {
    place = { top: scroller.scrollTop, left: scroller.scrollLeft };
  };
  const observer = new MutationObserver((records) => {
    const focused = document.activeElement;
    if (
      !focused ||
      !scroller.contains(focused) ||
      (scroller.scrollTop === place.top && scroller.scrollLeft === place.left)
    )
      return;
    const moved = records.some((record) =>
      [...record.addedNodes].some((node) => node.contains(focused)),
    );
    if (moved) scroller.scrollTo({ ...place, behavior: 'instant' });
  });
  scroller.addEventListener('scroll', record, { passive: true });
  observer.observe(scroller, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    scroller.removeEventListener('scroll', record);
  };
}
