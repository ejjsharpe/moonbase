export type LabelMatch = { positions: number[]; score: number };

/** Case-insensitive: a contiguous run scores above letters scattered through the label. */
export function matchLabel(label: string, query: string): LabelMatch | null {
  const text = label.toLowerCase(),
    wanted = query.trim().toLowerCase();
  if (!wanted) return { positions: [], score: 0 };
  const at = text.indexOf(wanted);
  if (at >= 0) {
    const boundary = at === 0 || /[^a-z0-9]/.test(text[at - 1]);
    return {
      positions: Array.from({ length: wanted.length }, (_, i) => at + i),
      score: 1000 + (boundary ? 200 : 0) - at,
    };
  }
  const letters = wanted.replace(/\s+/g, ''),
    positions: number[] = [];
  for (let i = 0, j = 0; i < text.length && j < letters.length; i++)
    if (text[i] === letters[j]) {
      positions.push(i);
      j++;
    }
  if (positions.length < letters.length) return null;
  return { positions, score: 500 - (positions.at(-1)! - positions[0]) };
}
