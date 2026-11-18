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
import { colors } from '@moonbase/ui/tokens.stylex';
import type { TranscriptContentState } from '@moonbase/application/chat';
import type { ChatTranscriptMatch, ChatTranscriptPart } from '@moonbase/contracts/chat';
import { TranscriptScroller, scrollToReading } from '../transcript-geometry.ts';
import { Note } from '../transcript-note.tsx';
import { textStyles } from '../transcript-text.ts';
import { locateFindRanges, paintFindRanges } from './find-ranges.ts';

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
  holdsGrowth,
  findHandOff,
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
  /**
   * Keeps the shown text while a growing part's next revision loads. Output that holds its own
   * previous body (`usePartBody`) shows the preview, so it can say which version it shows.
   */
  holdsGrowth: boolean;
  /** Text already shown for this part elsewhere (the running response it was), held until it loads. */
  findHandOff?: () => string | undefined;
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
  const [reading, setReading] = useState(() => {
    const handedOff = holdsGrowth && part.truncated && !content ? findHandOff?.() : undefined;
    return { revision: part.revision, text: handedOff ?? part.text, held: handedOff !== undefined };
  });
  const { text, held } = useMemo(() => {
    const revised = reading.revision !== part.revision;
    if (frozen && !revised) return reading;
    if (content?.chunks.length) return { text: original, held: false };
    // A streaming part's next revision carries only a preview until its content loads. The text
    // already shown still reads on from that preview, so it stays until then rather than
    // shrinking to the preview each update. Content released at the same revision shows the preview.
    const holds =
      holdsGrowth &&
      (revised || reading.held) &&
      part.truncated &&
      reading.text.length > part.text.length &&
      reading.text.startsWith(part.text);
    return holds ? { text: reading.text, held: true } : { text: part.text, held: false };
  }, [reading, part, frozen, content, original, holdsGrowth]);
  if (
    reading.revision !== part.revision ||
    (!frozen && (text !== reading.text || held !== reading.held))
  )
    setReading({ revision: part.revision, text, held });
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
  const activeRange = useRef<StaticRange | null>(null),
    mark = useRef<HTMLElement>(null);
  const [unlocated, setUnlocated] = useState<typeof match>(null);
  /** The active match once highlighted in place. */
  const [placed, setPlaced] = useState<typeof match>(null);
  if (!match && placed) setPlaced(null);
  useLayoutEffect(() => {
    const root = rendered.current;
    if (!root || !findStarts.length) return;
    let clear = () => {};
    const paint = () => {
      clear();
      // Rendered text can be mapped only when it renders the original source from its start.
      const ranges = (
        frozen || shown.retainedFrom ? null : locateFindRanges(root, shown.text, query, findStarts)
      )?.map((range) => range && new StaticRange(range));
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
      if (active) setPlaced(match);
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
      <Note>Match in original source</Note>
      <pre {...stylex.props(textStyles.literal)}>
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

const styles = stylex.create({
  match: { backgroundColor: colors.selection, color: colors.text, fontWeight: 700 },
});
