import { getChatFindExpression } from '@moonbase/contracts/chat';

/**
 * Rendered elements can declare which source they render, so Find maps occurrences within that
 * span only: `data-find-source="start:end"` (UTF-16 offsets into the part's source). Text inside
 * `data-find-ignore` (labels and other chrome) or a button is not source and is skipped.
 */
const findSourceAttribute = 'data-find-source';
export const getFindSourceProps = (start: number, end: number) => ({
  [findSourceAttribute]: `${start}:${end}`,
});
type FindSegment = { start: number; end: number; inner: FindSegment[] };
type RenderedMatch = { range: Range; before?: string; after?: string };

/**
 * Maps original-source match starts to rendered ranges. Each match is mapped within the innermost
 * declared span containing it, to the same occurrence among that span's rendered matches. A span
 * maps none of its matches (null), so the excerpt shows instead of the wrong text, when its counts
 * differ or when a pair's neighbouring characters differ, for example when an unrendered link URL
 * and decoded entity text both match. A rendered match crossing spans is not source text.
 */
export function locateFindRanges(root: Element, source: string, query: string, starts: number[]) {
  if (!query) return starts.map(() => null);
  const top: FindSegment = { start: 0, end: source.length, inner: [] };
  const declared = new Map<Element, FindSegment>();
  const segmentOf = (element: Element | null) => {
    const owner = element?.closest(`[${findSourceAttribute}]`);
    return (owner && declared.get(owner)) || top;
  };
  for (const element of root.querySelectorAll(`[${findSourceAttribute}]`)) {
    const [start, end] = element.getAttribute(findSourceAttribute)!.split(':').map(Number);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start! > end!) continue;
    const segment = { start: start!, end: end!, inner: [] };
    segmentOf(element.parentElement).inner.push(segment);
    declared.set(element, segment);
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      !node.nodeValue || node.parentElement?.closest('button, [data-find-ignore]')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: { node: Node; start: number; end: number; segment: FindSegment }[] = [];
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const start = text.length;
    text += node.nodeValue;
    nodes.push({ node, start, end: text.length, segment: segmentOf(node.parentElement) });
  }
  /** The text node holding `offset`. */
  const nodeAt = (offset: number) => {
    let low = 0,
      high = nodes.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (nodes[middle]!.start <= offset) low = middle;
      else high = middle - 1;
    }
    return nodes[low]!;
  };
  const groups = new Map<
    FindSegment,
    { expected: { start: number; end: number }[]; rendered: RenderedMatch[] }
  >();
  const groupOf = (segment: FindSegment) => {
    let group = groups.get(segment);
    if (!group) groups.set(segment, (group = { expected: [], rendered: [] }));
    return group;
  };
  const expression = getChatFindExpression(query);
  for (const hit of source.matchAll(expression)) {
    const end = hit.index + hit[0].length;
    let segment = top;
    for (
      let inner = segment.inner.find((item) => item.start <= hit.index && end <= item.end);
      inner;
      inner = segment.inner.find((item) => item.start <= hit.index && end <= item.end)
    )
      segment = inner;
    groupOf(segment).expected.push({ start: hit.index, end });
  }
  for (const hit of text.matchAll(expression)) {
    const end = hit.index + hit[0].length;
    const first = nodeAt(hit.index),
      last = nodeAt(end - 1);
    if (first.segment !== last.segment) continue;
    const range = document.createRange();
    range.setStart(first.node, hit.index - first.start);
    range.setEnd(last.node, end - last.start);
    // Neighbours in another text node may be separated by markup, so only these are compared.
    groupOf(first.segment).rendered.push({
      range,
      ...(hit.index > first.start && { before: text[hit.index - 1] }),
      ...(end < last.end && { after: text[end] }),
    });
  }
  const located = new Map<number, Range>();
  for (const { expected, rendered } of groups.values()) {
    const paired =
      expected.length === rendered.length &&
      expected.every(({ start, end }, index) => {
        const { before, after } = rendered[index]!;
        return (
          (before === undefined || isSameText(before, source[start - 1])) &&
          (after === undefined || isSameText(after, source[end]))
        );
      });
    if (paired) expected.forEach(({ start }, index) => located.set(start, rendered[index]!.range));
  }
  return starts.map((start) => located.get(start) ?? null);
}
/** Compares one rendered and one source character; code blocks render CR as LF. */
function isSameText(rendered: string, source: string | undefined) {
  return rendered === source || (rendered === '\n' && source === '\r');
}
/**
 * Adds ranges to the named CSS custom highlight until the returned cleanup runs. The ranges are
 * static: the list moves rows' containers to keep them in DOM order, which would collapse live
 * ranges, and the part repaints its own content changes.
 */
export function paintFindRanges(name: 'find-match' | 'find-active', ranges: StaticRange[]) {
  if (!ranges.length) return () => {};
  const highlight = CSS.highlights.get(name) ?? new Highlight();
  highlight.priority = name === 'find-active' ? 1 : 0;
  CSS.highlights.set(name, highlight);
  for (const range of ranges) highlight.add(range);
  return () => {
    for (const range of ranges) highlight.delete(range);
    if (!highlight.size && CSS.highlights.get(name) === highlight) CSS.highlights.delete(name);
  };
}
