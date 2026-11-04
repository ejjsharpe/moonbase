export type SourceRange = { start: number; end: number };
export type CodeSource = {
  start: number;
  end: number;
  ranges: SourceRange[];
  text: string;
  closed: boolean;
};

/** Source locations only. Marked owns Markdown interpretation; normalized tokens never authorize Copy. */
export function locateFences(source: string) {
  const lines = [...source.matchAll(/[^\n]*(?:\n|$)/g)].filter((line) => line[0].length);
  const results: CodeSource[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]![0];
    let offset = 0;
    const prefixes: (number | 'quote')[] = [];
    for (;;) {
      const container = /^( *)(> ?|(?:[-+*]|\d+[.)]) +)/.exec(line.slice(offset));
      if (!container) break;
      if (container[1]!.length) prefixes.push(container[1]!.length);
      prefixes.push(container[2]!.startsWith('>') ? 'quote' : container[2]!.length);
      offset += container[0].length;
    }
    const open = /^( *)(`{3,}|~{3,})([^\r\n]*)\r?\n?$/.exec(line.slice(offset));
    if (!open || (open[2]![0] === '`' && open[3]!.includes('`'))) continue;
    if (open[1]!.length) prefixes.push(open[1]!.length);
    const start = lines[i]!.index!;
    const marker = open[2]![0]!,
      length = open[2]!.length;
    const strip = (value: string) => {
      let position = 0;
      for (const prefix of prefixes) {
        if (prefix === 'quote') {
          const quote = /^ {0,3}> ?/.exec(value.slice(position));
          if (!quote) return null;
          position += quote[0].length;
        } else {
          let spaces = 0;
          while (spaces < prefix && value[position] === ' ') {
            spaces++;
            position++;
          }
        }
      }
      return position;
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
