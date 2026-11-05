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
import type { ChatTranscriptMatch, ChatTranscriptPart } from '@moonbase/contracts/chat';
import { locateFindRanges, paintFindRanges } from './find.tsx';
import { TranscriptScroller, scrollToReading } from './transcript-geometry.ts';
import { transcriptStyles as styles } from './transcript-styles.ts';

/** Original-source context shown around a match the rendered text cannot locate. */
const excerptContextUnits = 120;

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
