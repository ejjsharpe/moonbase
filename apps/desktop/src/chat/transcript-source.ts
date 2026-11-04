import { Lexer, Tokenizer, type Token, type Tokens } from 'marked';

export type SourceRange = { start: number; end: number };
export type CodeSource = {
  start: number;
  end: number;
  ranges: SourceRange[];
  text: string;
  closed: boolean;
};

type Span = SourceRange & { text: string; from: number; to: number };
type Projection = { text: string; spans: Span[] };
// CRLF and expanded container tabs keep their original spans, including a partially consumed tab.
function project(pieces: (SourceRange & { text: string })[]): Projection {
  let offset = 0;
  const spans = pieces
    .filter((piece) => piece.text.length)
    .map((piece) => {
      const from = offset;
      offset += piece.text.length;
      return { ...piece, from, to: offset };
    });
  return { text: spans.map((span) => span.text).join(''), spans };
}
function slice(view: Projection, start: number, end = view.text.length): Projection {
  let low = 0,
    high = view.spans.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (view.spans[mid]!.to <= start) low = mid + 1;
    else high = mid;
  }
  const pieces: (SourceRange & { text: string })[] = [];
  for (let i = low; i < view.spans.length && view.spans[i]!.from < end; i++) {
    const span = view.spans[i]!,
      a = Math.max(start, span.from),
      b = Math.min(end, span.to);
    const linear = span.end - span.start === span.text.length;
    pieces.push({
      text: view.text.slice(a, b),
      start: linear ? span.start + a - span.from : span.start,
      end: linear ? span.start + b - span.from : span.end,
    });
  }
  return project(pieces);
}
function splitLines(view: Projection) {
  return [...view.text.matchAll(/[^\n]*(?:\n|$)/g)]
    .filter((line) => line[0].length)
    .map((line) => slice(view, line.index!, line.index! + line[0].length));
}
function join(views: Projection[]) {
  return project(views.flatMap((view) => view.spans));
}
function expandIndent(line: Projection, column = 0) {
  const prefix = /^[ \t]*/.exec(line.text)![0];
  if (!prefix.includes('\t')) return line;
  const pieces: Projection[] = [];
  for (let i = 0; i < prefix.length; i++) {
    const part = slice(line, i, i + 1),
      width = prefix[i] === '\t' ? 4 - (column % 4) : 1;
    pieces.push(project(part.spans.map((span) => ({ ...span, text: ' '.repeat(width) }))));
    column += width;
  }
  return join([...pieces, slice(line, prefix.length)]);
}
function stripQuote(view: Projection) {
  return join(
    splitLines(view).map((line) => {
      const marker = /^ {0,3}>/.exec(line.text);
      if (!marker) return line;
      const rest = expandIndent(slice(line, marker[0].length), marker[0].length);
      return slice(rest, rest.text.startsWith(' ') ? 1 : 0);
    }),
  );
}
function stripListIndent(view: Projection) {
  const rows = splitLines(view),
    first = rows[0]!;
  const marker = /^ {0,3}(?:[-+*]|\d{1,9}[.)])/.exec(first.text);
  if (!marker) return view;
  const rest = expandIndent(slice(first, marker[0].length), marker[0].length);
  let padding = /^ */.exec(rest.text)![0].length;
  if (!rest.text.trim() || padding > 4) padding = 1;
  const indent = marker[0].length + padding;
  return join([
    slice(rest, padding),
    ...rows.slice(1).map((line) => {
      const expanded = expandIndent(line);
      return !expanded.text.trim() || /^ */.exec(expanded.text)![0].length >= indent
        ? slice(expanded, Math.min(indent, /^ */.exec(expanded.text)![0].length))
        : line;
    }),
  ]);
}

/** Marked classifies regions first; only original source spans authorize Copy. */
export function locateFences(
  source: string,
  tokens?: Token[],
  onFence?: (token: Tokens.Code, location: CodeSource) => void,
) {
  const tokenizer = new Tokenizer(),
    lexer = new Lexer({ gfm: true, tokenizer });
  const results: CodeSource[] = [];
  const root = project(
    [...source.matchAll(/[^\r\n]+|\r\n?|\n/g)].map((match) => ({
      text: match[0][0] === '\r' ? '\n' : match[0],
      start: match.index!,
      end: match.index! + match[0].length,
    })),
  );
  function visit(blocks: Token[], view: Projection) {
    let offset = 0;
    for (const token of blocks) {
      // Definitions/blank lines may be omitted from Marked's block token sequence.
      while (!view.text.startsWith(token.raw, offset)) {
        const remaining = view.text.slice(offset),
          omitted = tokenizer.space(remaining) ?? tokenizer.def(remaining);
        if (!omitted?.raw.length) return;
        offset += omitted.raw.length;
      }
      const region = slice(view, offset, offset + token.raw.length);
      offset += token.raw.length;
      if (token.type === 'list') visit((token as Tokens.List).items, region);
      else if (token.type === 'list_item')
        visit((token as Tokens.ListItem).tokens, stripListIndent(region));
      else if (token.type === 'blockquote')
        visit((token as Tokens.Blockquote).tokens, stripQuote(region));
      else if (token.type === 'code' && token.codeBlockStyle !== 'indented') {
        const rows = splitLines(region),
          opening = /^( {0,3})(`{3,}|~{3,})/.exec(rows[0]?.text ?? '');
        if (!opening) continue;
        const last = rows.at(-1)!,
          closing = /^ {0,3}(`+|~+)[ \t]*(?:\n)?$/.exec(last.text);
        const closed =
          rows.length > 1 &&
          !!closing &&
          closing[1]![0] === opening[2]![0] &&
          closing[1]!.length >= opening[2]!.length;
        const body = rows
          .slice(1, closed ? -1 : undefined)
          .map((line) =>
            slice(line, Math.min(opening[1]!.length, /^ */.exec(line.text)![0].length)),
          );
        const ranges: SourceRange[] = [];
        for (const span of join(body).spans) {
          const previous = ranges.at(-1);
          if (previous && span.start <= previous.end)
            previous.end = Math.max(previous.end, span.end);
          else ranges.push({ start: span.start, end: span.end });
        }
        // Container tokens trim their last line; retain authored trailing whitespace/newlines.
        if (!closed && ranges.length) {
          const lastRange = ranges.at(-1)!,
            lineEnd = source.indexOf('\n', lastRange.end);
          const end = lineEnd < 0 ? source.length : lineEnd + 1;
          if (!source.slice(lastRange.end, end).trim()) lastRange.end = end;
        }
        const first = region.spans[0]!,
          end = region.spans.at(-1)!.end;
        const start =
          Math.max(
            source.lastIndexOf('\n', first.start - 1),
            source.lastIndexOf('\r', first.start - 1),
          ) + 1;
        const location = {
          start,
          end,
          ranges,
          text: ranges.map((range) => source.slice(range.start, range.end)).join(''),
          closed,
        };
        results.push(location);
        onFence?.(token as Tokens.Code, location);
      }
    }
  }
  try {
    visit(tokens ?? lexer.lex(source), root);
  } catch {
    /* Malformed/deep input remains readable without an unproved Copy location. */
  }
  return results;
}

/** View-memory keys must fit its byte bound even when both public IDs are maximal. */
export function getTranscriptDisclosureId(
  entryId: string,
  partId: string,
): string | Promise<string> {
  const identity = JSON.stringify([entryId, partId]),
    data = new TextEncoder().encode(identity);
  if (data.length <= 256) return identity;
  return crypto.subtle
    .digest('SHA-256', data)
    .then(
      (digest) =>
        'sha256:' +
        [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    );
}
