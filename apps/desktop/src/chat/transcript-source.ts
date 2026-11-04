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
    const open =
      /^((?: {0,3}> ?)*)( {0,3})((?:[-+*]|\d+[.)]) +)?(`{3,}|~{3,})([^\r\n]*)\r?\n?$/.exec(line);
    if (!open || (open[4]![0] === '`' && open[5]!.includes('`'))) continue;
    const start = lines[i]!.index!;
    const marker = open[4]![0]!,
      length = open[4]!.length;
    const quotes = (open[1]!.match(/>/g) ?? []).length;
    const indentSize = open[2]!.length + (open[3]?.length ?? 0);
    const strip = (value: string) => {
      let offset = 0;
      for (let quote = 0; quote < quotes; quote++) {
        const prefix = /^ {0,3}> ?/.exec(value.slice(offset));
        if (!prefix) return null;
        offset += prefix[0].length;
      }
      return offset + Math.min(indentSize, /^ */.exec(value.slice(offset))![0].length);
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
