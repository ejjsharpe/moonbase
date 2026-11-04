export type SourceRange = { start: number; end: number };
export type CodeSource = {
  start: number;
  end: number;
  ranges: SourceRange[];
  text: string;
  closed: boolean;
};

function readQuotePrefix(line: string, count = Infinity) {
  let offset = 0,
    quotes = 0;
  while (quotes < count) {
    let marker = offset;
    while (line[marker] === ' ' && marker < offset + 3) marker++;
    if (line[marker] !== '>') break;
    offset = marker + 1;
    if (line[offset] === ' ') offset++;
    quotes++;
  }
  return { offset, quotes };
}

/** Source locations only. Marked owns Markdown interpretation; normalized tokens never authorize Copy. */
export function locateFences(source: string) {
  const lines = [...source.matchAll(/[^\n]*(?:\n|$)/g)].filter((line) => line[0].length);
  const results: CodeSource[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]![0];
    const prefix = readQuotePrefix(line);
    const open = /^( *)((?:[-+*]|\d+[.)]) +)?(`{3,}|~{3,})([^\r\n]*)\r?\n?$/.exec(
      line.slice(prefix.offset),
    );
    if (!open || (open[3]![0] === '`' && open[4]!.includes('`'))) continue;
    const start = lines[i]!.index!;
    const marker = open[3]![0]!,
      length = open[3]!.length;
    const indentSize = open[1]!.length + (open[2]?.length ?? 0);
    const strip = (value: string) => {
      const body = readQuotePrefix(value, prefix.quotes);
      if (body.quotes !== prefix.quotes) return null;
      return body.offset + Math.min(indentSize, /^ */.exec(value.slice(body.offset))![0].length);
    };
    const ranges: SourceRange[] = [];
    let closed = false;
    for (i++; i < lines.length; i++) {
      const next = lines[i]!,
        indent = strip(next[0]);
      if (indent === null) {
        i--;
        break;
      }
      const closing = /^[ \t]{0,3}(`+|~+)[ \t]*\r?\n?$/.exec(next[0].slice(indent));
      if (closing && closing[1]![0] === marker && closing[1]!.length >= length) {
        closed = true;
        break;
      }
      // Fenced indentation belongs to Markdown; retain every original code byte after that prefix.
      ranges.push({ start: next.index! + indent, end: next.index! + next[0].length });
    }
    if (!ranges.length)
      ranges.push({
        start: lines[Math.min(i, lines.length - 1)]!.index!,
        end: lines[Math.min(i, lines.length - 1)]!.index!,
      });
    results.push({
      start,
      end: i < lines.length ? lines[i]!.index! + lines[i]![0].length : source.length,
      ranges,
      text: ranges.map((range) => source.slice(range.start, range.end)).join(''),
      closed,
    });
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
