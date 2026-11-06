import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import * as stylex from '@stylexjs/stylex';
import type { TranscriptContentState } from '@moonbase/application/chat';
import {
  getChatFindExpression,
  type ChatTranscriptMatch,
  type ChatTranscriptPart,
} from '@moonbase/contracts/chat';
import { TranscriptScroller, scrollToReading } from './transcript-geometry.ts';
import { transcriptStyles as styles } from './transcript-styles.ts';

/** Original-source context shown around a match the rendered text cannot locate. */
const excerptContextUnits = 120;

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
function locateFindRanges(root: Element, source: string, query: string, starts: number[]) {
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
/** Adds ranges to the named CSS custom highlight until the returned cleanup runs. */
function paintFindRanges(name: 'find-match' | 'find-active', ranges: Range[]) {
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

/**
 * Find hydration for one part: which text to render while the active match's source loads, and
 * whether that text is the complete source.
 */
export function useFindHydration({
  part,
  match,
  revealing,
  content,
  base,
  original,
  readable,
  shown,
  load,
}: {
  part: ChatTranscriptPart;
  /** The active Find match, when it is in this part. */
  match: ChatTranscriptMatch | null;
  revealing: boolean;
  content: TranscriptContentState | undefined;
  base: number;
  original: string;
  readable: boolean;
  /** The part's body is rendered (an ordinary part, or an expanded disclosure). */
  shown: boolean;
  load(restart?: boolean): void;
}) {
  const matchedText =
    match && match.start >= base ? original.slice(match.start - base, match.end - base) : null;
  const expectedText = match?.snippet.text.slice(
    match.start - match.snippet.start,
    match.end - match.snippet.start,
  );
  const matchVisible = !!match && matchedText === expectedText;
  // Preserve the reading body while Find hydrates; show the source once it contains the match.
  const frozen = !!match && !(matchVisible && base === 0);
  const [reading, setReading] = useState({ revision: part.revision, text: part.text });
  const text = useMemo(() => {
    if (reading.revision !== part.revision) return part.text;
    if (frozen) return reading.text;
    return content?.chunks.length ? original : part.text;
  }, [reading, part, frozen, content, original]);
  if (reading.revision !== part.revision || (!frozen && text !== reading.text))
    setReading({ revision: part.revision, text });
  const complete =
    !part.truncated ||
    (content?.status === 'complete' &&
      content.retainedFrom === 0 &&
      content.loadedBytes === part.bytes &&
      (!match || text.length === content.loadedText));
  useEffect(() => {
    if (
      !match ||
      !revealing ||
      !readable ||
      !shown ||
      content?.error ||
      content?.status === 'loading'
    )
      return;
    if (match.start < base) load(true);
    else if (!matchVisible && (!content || content.status === 'partial')) load();
  }, [match, readable, shown, content, base, matchVisible, load, revealing]);
  return { text, frozen, matchVisible, matchedText, complete };
}

/**
 * Paints this part's Find matches over its rendered text and reveals the active one, falling back
 * to an original-source excerpt when the rendering cannot locate it.
 */
export function useFindHighlight({
  rendered,
  match,
  matches,
  partId,
  query,
  revealing,
  frozen,
  matchVisible,
  shown,
  expanded,
}: {
  rendered: RefObject<HTMLElement | null>;
  match: ChatTranscriptMatch | null;
  /** Find matches in this part's source. */
  matches: readonly ChatTranscriptMatch[];
  partId: string;
  query: string;
  revealing: boolean;
  frozen: boolean;
  matchVisible: boolean;
  shown: { text: string; retainedFrom: number };
  expanded: boolean;
}) {
  const scroller = useContext(TranscriptScroller);
  const findStarts = useMemo(() => {
    const starts = matches
      .filter((item) => item.partId === partId)
      .map((item) => item.start)
      .filter((start) => start !== match?.start);
    return match ? [match.start, ...starts] : starts;
  }, [matches, partId, match]);
  const activeRange = useRef<Range | null>(null),
    mark = useRef<HTMLElement>(null);
  const [unlocated, setUnlocated] = useState<typeof match>(null);
  /** The active match once highlighted in place. */
  const [placed, setPlaced] = useState<typeof match>(null);
  if (!match && placed) setPlaced(null);
  useLayoutEffect(() => {
    const root = rendered.current;
    if (!root || !findStarts.length) return;
    let clear = () => {};
    let painted: Range[] = [];
    const paint = () => {
      clear();
      // Rendered text can be mapped only when it renders the original source from its start.
      const ranges =
        frozen || shown.retainedFrom ? null : locateFindRanges(root, shown.text, query, findStarts);
      const active = (match && ranges?.[0]) || null;
      activeRange.current = active;
      const others = ranges?.slice(match ? 1 : 0).filter((range) => !!range) ?? [];
      painted = active ? [active, ...others] : others;
      const clearMatches = paintFindRanges('find-match', others),
        clearActive = paintFindRanges('find-active', active ? [active] : []);
      clear = () => {
        clearMatches();
        clearActive();
      };
      setUnlocated(match && !active ? match : null);
      if (active) setPlaced(match);
    };
    paint();
    const observer = new MutationObserver(paint);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    // The list moves rows' containers to keep them in DOM order, and moving a node collapses the
    // ranges in it; this part's own observer can't see itself moved.
    const list = scroller.current;
    const moves = new MutationObserver(() => {
      if (painted.some((range) => !root.contains(range.startContainer))) paint();
    });
    if (list) moves.observe(list, { childList: true, subtree: true });
    return () => {
      moves.disconnect();
      observer.disconnect();
      clear();
      activeRange.current = null;
    };
  }, [
    rendered,
    scroller,
    findStarts,
    frozen,
    shown.text,
    shown.retainedFrom,
    query,
    match,
    expanded,
  ]);
  // A match the reader hid after it was highlighted, by folding it or turning the page, shows no
  // excerpt: it would grow the transcript around them.
  const excerpt = !!match && matchVisible && unlocated === match && placed !== match;
  /** The match last scrolled to, and whether it was highlighted in place. */
  const revealed = useRef<{ match: ChatTranscriptMatch; inPlace: boolean } | null>(null);
  useLayoutEffect(() => {
    const target = excerpt ? mark.current : activeRange.current;
    if (!match || !revealing) revealed.current = null;
    if (!match || !revealing || !target) return;
    // Scroll for a newly revealed match, or once its excerpt is replaced in place.
    const previous = revealed.current;
    if (previous?.match === match && (previous.inPlace || excerpt)) return;
    revealed.current = { match, inPlace: !excerpt };
    scrollToReading(target, scroller.current);
  }, [match, revealing, frozen, excerpt, expanded, scroller]);
  return { excerpt, mark };
}

export function FindExcerpt({
  original,
  base,
  match,
  matchedText,
  mark,
}: {
  original: string;
  base: number;
  match: ChatTranscriptMatch;
  matchedText: string | null;
  mark: RefObject<HTMLElement | null>;
}) {
  return (
    <section aria-label="Matched original source">
      <p {...stylex.props(styles.small)}>Match in original source</p>
      <pre {...stylex.props(styles.literal)}>
        {original
          .slice(Math.max(0, match.start - base - excerptContextUnits), match.start - base)
          .replace(/^[\udc00-\udfff]/, '')}
        <mark ref={mark} data-transcript-find-match {...stylex.props(styles.match)}>
          {matchedText}
        </mark>
        {original
          .slice(match.end - base, match.end - base + excerptContextUnits)
          .replace(/[\ud800-\udbff]$/, '')}
      </pre>
    </section>
  );
}
