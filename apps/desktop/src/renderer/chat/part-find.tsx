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
export const findSourceAttribute = 'data-find-source';
export const getFindSourceProps = (start: number, end: number) => ({
  [findSourceAttribute]: `${start}:${end}`,
});
type FindSegment = { start: number; end: number; parent: FindSegment | null; inner: FindSegment[] };

/**
 * Maps original-source match starts to rendered ranges. Each match is mapped within the innermost
 * declared span containing it, to the same occurrence among that span's rendered matches. A span
 * whose rendered and source occurrence counts differ maps none of its matches (null), so a match is
 * never highlighted on the wrong text, for example when footnotes render out of source order.
 */
export function locateFindRanges(root: Element, source: string, query: string, starts: number[]) {
  if (!query) return starts.map(() => null);
  const top: FindSegment = { start: 0, end: source.length, parent: null, inner: [] };
  const declared = new Map<Element, FindSegment>();
  const segmentOf = (element: Element | null) => {
    const owner = element?.closest(`[${findSourceAttribute}]`);
    return (owner && declared.get(owner)) || top;
  };
  for (const element of root.querySelectorAll(`[${findSourceAttribute}]`)) {
    const [start, end] = element.getAttribute(findSourceAttribute)!.split(':').map(Number);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start! > end!) continue;
    const parent = segmentOf(element.parentElement);
    const segment = { start: start!, end: end!, parent, inner: [] };
    parent.inner.push(segment);
    declared.set(element, segment);
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest('button, [data-find-ignore]')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: { node: Node; start: number; segment: FindSegment }[] = [];
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push({ node, start: text.length, segment: segmentOf(node.parentElement) });
    text += node.nodeValue;
  }
  const groups = new Map<FindSegment, { expected: number[]; rendered: Range[] }>();
  const groupOf = (segment: FindSegment) => {
    let group = groups.get(segment);
    if (!group) groups.set(segment, (group = { expected: [], rendered: [] }));
    return group;
  };
  for (const hit of source.matchAll(getChatFindExpression(query))) {
    const end = hit.index + hit[0].length;
    let segment = top;
    for (
      let inner = segment.inner.find((item) => item.start <= hit.index && end <= item.end);
      inner;
      inner = segment.inner.find((item) => item.start <= hit.index && end <= item.end)
    )
      segment = inner;
    groupOf(segment).expected.push(hit.index);
  }
  for (const hit of text.matchAll(getChatFindExpression(query))) {
    const end = hit.index + hit[0].length;
    const first = nodes.findLast((item) => item.start <= hit.index)!,
      last = nodes.findLast((item) => item.start < end)!;
    // A match crossing spans belongs to the innermost span containing both ends.
    let segment = first.segment;
    while (segment.parent && !isWithin(last.segment, segment)) segment = segment.parent;
    const range = document.createRange();
    range.setStart(first.node, hit.index - first.start);
    range.setEnd(last.node, end - last.start);
    groupOf(segment).rendered.push(range);
  }
  const located = new Map<number, Range>();
  for (const { expected, rendered } of groups.values())
    if (expected.length === rendered.length)
      expected.forEach((start, index) => located.set(start, rendered[index]!));
  return starts.map((start) => located.get(start) ?? null);
}
function isWithin(segment: FindSegment, ancestor: FindSegment) {
  for (let current: FindSegment | null = segment; current; current = current.parent)
    if (current === ancestor) return true;
  return false;
}
/** Adds ranges to the named CSS custom highlight until the returned cleanup runs. */
export function paintFindRanges(name: 'find-match' | 'find-active', ranges: Range[]) {
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
  useLayoutEffect(() => {
    const root = rendered.current;
    if (!root || !findStarts.length) return;
    let clear = () => {};
    const paint = () => {
      clear();
      // Rendered text can be mapped only when it renders the original source from its start.
      const ranges =
        frozen || shown.retainedFrom ? null : locateFindRanges(root, shown.text, query, findStarts);
      const active = (match && ranges?.[0]) || null;
      activeRange.current = active;
      const others = ranges?.slice(match ? 1 : 0).filter((range) => !!range) ?? [];
      const clearMatches = paintFindRanges('find-match', others),
        clearActive = paintFindRanges('find-active', active ? [active] : []);
      clear = () => {
        clearMatches();
        clearActive();
      };
      setUnlocated(match && !active ? match : null);
    };
    paint();
    const observer = new MutationObserver(paint);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      clear();
      activeRange.current = null;
    };
  }, [rendered, findStarts, frozen, shown.text, shown.retainedFrom, query, match, expanded]);
  const excerpt = !!match && matchVisible && unlocated === match;
  useLayoutEffect(() => {
    const target = excerpt ? mark.current : activeRange.current;
    if (revealing && target) scrollToReading(target, scroller.current);
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
