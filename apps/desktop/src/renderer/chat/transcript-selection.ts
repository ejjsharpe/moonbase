type Held = { anchor: Node; anchorOffset: number; focus: Node; focusOffset: number };

/**
 * Keeps the reader's selection in the transcript as the list moves and recycles the row
 * containers around it. The list reorders containers into index order after scrolling, and moving
 * a node that holds a selection boundary changes the selection though the reader did nothing. The
 * move is observed before the selection change it causes, so the selection the reader made is put
 * back. Until that reorder, a container recycled for a row scrolled into view can sit between the
 * selection's rows, which adds its row to the selection; it is moved out at once. `findRowIndex`
 * gives a row key's index in the transcript, or -1. Returns the cleanup.
 */
export function holdTranscriptSelection(
  scroller: HTMLElement,
  findRowIndex: (key: string) => number,
) {
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
    if (!held || !selection || !scroller.contains(held.anchor) || !scroller.contains(held.focus))
      return;
    const { anchor, anchorOffset, focus, focusOffset } = held;
    const moved = records.some((record) =>
      [...record.addedNodes].some((node) => node.contains(anchor) || node.contains(focus)),
    );
    if (moved) selection.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
    moveOtherRowsOutOfSelection(anchor, focus, findRowIndex);
  });
  observer.observe(scroller, { childList: true, subtree: true });
  document.addEventListener('selectionchange', remember);
  remember();
  return () => {
    observer.disconnect();
    document.removeEventListener('selectionchange', remember);
  };
}

const findRow = (node: Node) =>
  (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
    '[data-transcript-row]',
  ) ?? null;

/**
 * Moves each container between the selection's first and last rows whose row lies outside them
 * to just before or after them, by its row's index. The selection's own containers stay put, so
 * its boundaries don't change.
 */
function moveOtherRowsOutOfSelection(
  anchor: Node,
  focus: Node,
  findRowIndex: (key: string) => number,
) {
  let first = findRow(anchor),
    last = findRow(focus);
  if (!first || !last || first === last) return;
  if (first.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_PRECEDING)
    [first, last] = [last, first];
  const parent = findCommonParent(first, last);
  if (!parent) return;
  const start = findChildContaining(parent, first),
    end = findChildContaining(parent, last);
  const indices = [first, last].map((row) => findRowIndex(row.dataset.transcriptRow!));
  const lowest = Math.min(...indices),
    highest = Math.max(...indices);
  if (lowest < 0) return;
  const before: Element[] = [],
    after: Element[] = [];
  for (
    let child = start.nextElementSibling;
    child && child !== end;
    child = child.nextElementSibling
  ) {
    const row = child.matches('[data-transcript-row]')
      ? (child as HTMLElement)
      : child.querySelector<HTMLElement>('[data-transcript-row]');
    const index = row ? findRowIndex(row.dataset.transcriptRow!) : -1;
    if (index < 0) continue;
    if (index < lowest) before.push(child);
    else if (index > highest) after.push(child);
  }
  const next = end.nextSibling;
  for (const child of before) moveChild(parent, child, start);
  for (const child of after) moveChild(parent, child, next);
}

function findCommonParent(first: Element, last: Element) {
  let parent = first.parentElement;
  while (parent && !parent.contains(last)) parent = parent.parentElement;
  return parent;
}
function findChildContaining(parent: Element, node: Element) {
  let child = node;
  while (child.parentElement !== parent) child = child.parentElement!;
  return child;
}
/** Moves without removing where the browser can, as the list does, so the row keeps its state. */
function moveChild(parent: Element, child: Element, before: Node | null) {
  if ('moveBefore' in parent && typeof parent.moveBefore === 'function')
    parent.moveBefore(child, before);
  else parent.insertBefore(child, before);
}
