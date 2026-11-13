import type { LookupMatch } from './workspace.ts';

/** Fuzzy path matcher shared by editor file lookup and chat file search. Positions are UTF-16 offsets, as consumed by React/Monaco. */
export function matchPath(path: string, query: string): LookupMatch | null {
  const pieces = [...query.matchAll(/"([^"]*)"|([^\s"]+)/g)]
    .map((m) => ({ text: m[1] ?? m[2], contiguous: m[1] !== undefined }))
    .filter((p) => p.text.length);
  if (!pieces.length) return { path, score: 0, positions: [] };
  const lower = path.toLowerCase(),
    basename = path.lastIndexOf('/') + 1;
  const offsets: number[] = [];
  let original = 0;
  for (const character of path) {
    for (let n = 0; n < character.toLowerCase().length; n++)
      offsets.push(original + Math.min(n, character.length - 1));
    original += character.length;
  }
  const foldedBasename = offsets.findIndex((p) => p >= basename);
  const boundary = (at: number) =>
    at === 0 ||
    /[/_\-.\s]/.test(path[at - 1]) ||
    (/[a-z]/.test(path[at - 1]) && /[A-Z]/.test(path[at]));
  const positions = new Set<number>();
  let score = 0;
  for (const piece of pieces) {
    const needle = piece.text.toLowerCase();
    const find = (start: number) => {
      const selected: number[] = [];
      let cursor = start;
      const contiguousAt = lower.indexOf(needle, start);
      if (piece.contiguous || contiguousAt >= 0) {
        const at = contiguousAt;
        if (at < 0) return null;
        for (let n = 0; n < needle.length; n++) selected.push(at + n);
      } else {
        for (let n = 0; n < needle.length; n++) {
          const at = lower.indexOf(needle[n], cursor);
          if (at < 0) return null;
          selected.push(at);
          cursor = at + 1;
        }
      }
      let value = 0;
      for (let n = 0; n < selected.length; n++) {
        const at = selected[n],
          position = offsets[at];
        value +=
          10 +
          (position >= basename ? 6 : 0) +
          (boundary(position) ? 8 : 0) +
          (path[position] === piece.text[n] ? 2 : 0);
        if (n) value += at === selected[n - 1] + 1 ? 12 : -Math.min(12, at - selected[n - 1] - 1);
      }
      if (selected[0] === foldedBasename) value += 24;
      if (needle === lower) value += 100;
      else if (needle === lower.slice(basename)) value += 70;
      if (piece.text.includes('/') && lower.includes(needle)) value += 40;
      return { offsets: selected.map((at) => offsets[at]), value };
    };
    const full = find(0),
      name = foldedBasename > 0 ? find(foldedBasename) : null;
    const best = name && (!full || name.value > full.value) ? name : full;
    if (!best) return null;
    best.offsets.forEach((p) => positions.add(p));
    score += best.value;
  }
  return {
    path,
    score: score - path.length / 1000,
    positions: [...positions].sort((a, b) => a - b),
  };
}
export const compareMatches = (a: LookupMatch, b: LookupMatch) =>
  b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path);
