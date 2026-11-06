type Held = { anchor: Node; anchorOffset: number; focus: Node; focusOffset: number };

/**
 * Keeps the reader's selection in the transcript when the list moves the row containers holding
 * it. The list reorders containers into index order after scrolling, and moving a node that holds
 * a selection boundary changes the selection though the reader did nothing. The move is observed
 * before the selection change it causes, so the selection the reader made is put back. Returns the
 * cleanup.
 */
export function holdTranscriptSelection(scroller: HTMLElement) {
  let held: Held | null = null;
  const remember = () => {
    const selection = window.getSelection();
    const { anchorNode, anchorOffset, focusNode, focusOffset } = selection ?? {};
    held =
      selection &&
      !selection.isCollapsed &&
      anchorNode &&
      focusNode &&
      scroller.contains(anchorNode) &&
      scroller.contains(focusNode)
        ? {
            anchor: anchorNode,
            anchorOffset: anchorOffset!,
            focus: focusNode,
            focusOffset: focusOffset!,
          }
        : null;
  };
  const observer = new MutationObserver((records) => {
    const selection = window.getSelection();
    const moved =
      held &&
      records.some((record) =>
        [...record.addedNodes].some(
          (node) => node.contains(held!.anchor) || node.contains(held!.focus),
        ),
      );
    if (!moved || !selection || !scroller.contains(held!.anchor) || !scroller.contains(held!.focus))
      return;
    selection.setBaseAndExtent(held!.anchor, held!.anchorOffset, held!.focus, held!.focusOffset);
  });
  observer.observe(scroller, { childList: true, subtree: true });
  document.addEventListener('selectionchange', remember);
  remember();
  return () => {
    observer.disconnect();
    document.removeEventListener('selectionchange', remember);
  };
}
