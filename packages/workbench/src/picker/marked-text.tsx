import * as stylex from '@stylexjs/stylex';
import type { TextMatch } from '@moonbase/contracts/workspace';
import { styles } from './picker-styles.ts';

/** Text with the characters at `positions` (offset by `offset`) marked, for Go to's matches. */
export function MarkedText({
  text,
  positions,
  offset = 0,
}: {
  text: string;
  positions: number[];
  offset?: number;
}) {
  if (!positions.length) return text;
  const marked = new Set(positions);
  return [...text].map((character, i) =>
    marked.has(i + offset) ? (
      <mark key={i} {...stylex.props(styles.mark)}>
        {character}
      </mark>
    ) : (
      character
    ),
  );
}

/** A line with Find's match ranges marked; `trim` drops leading indentation for the list. */
export function MarkedRanges({
  text,
  ranges,
  trim = false,
}: {
  text: string;
  ranges: TextMatch['ranges'];
  trim?: boolean;
}) {
  const pieces = [];
  let from = trim ? Math.min(text.length - text.trimStart().length, ranges[0]?.start ?? 0) : 0;
  for (const [i, range] of ranges.entries()) {
    if (range.start < from) continue;
    pieces.push(text.slice(from, range.start));
    pieces.push(
      <mark key={i} {...stylex.props(styles.mark, styles.found)}>
        {text.slice(range.start, range.end)}
      </mark>,
    );
    from = range.end;
  }
  pieces.push(text.slice(from));
  return pieces;
}
