import { parsePatch } from 'diff';

export type PatchLine = {
  old?: number;
  next?: number;
  kind: 'added' | 'removed' | 'context' | 'notice';
  text: string;
};
export type RecordedPatch =
  | {
      files: {
        old: string;
        next: string;
        hunks: { old: number; next: number; lines: PatchLine[] }[];
      }[];
    }
  | { fallback: string };

/** Interpret retained unified source only. No filesystem or edit reconstruction. */
export function parseRecordedPatch(source: string, complete = true): RecordedPatch {
  if (!complete) return { fallback: 'Incomplete patch source. Read more to view its hunks.' };
  if (source.length > 64 * 1024 || source.split('\n').length > 2000)
    return { fallback: 'Large patch. Showing recorded source without parsing.' };
  try {
    // jsdiff can silently zero an unfulfilled count at bare EOF.
    const patches = parsePatch(source.endsWith('\n') ? source : source + '\n');
    if (!patches.length || !patches.every((patch) => patch.hunks.length)) throw Error();
    return {
      files: patches.map((patch) => ({
        old: patch.oldFileName ?? 'Recorded old source',
        next: patch.newFileName ?? 'Recorded new source',
        hunks: patch.hunks.map((hunk) => {
          if (
            ![hunk.oldStart, hunk.newStart, hunk.oldLines, hunk.newLines].every(
              (n) => Number.isSafeInteger(n) && n >= 0,
            )
          )
            throw Error();
          if ((hunk.oldLines && !hunk.oldStart) || (hunk.newLines && !hunk.newStart)) throw Error();
          let old = hunk.oldStart,
            next = hunk.newStart;
          const lines = hunk.lines.map((text): PatchLine => {
            if (text.startsWith('+')) return { next: next++, kind: 'added', text };
            if (text.startsWith('-')) return { old: old++, kind: 'removed', text };
            if (text.startsWith('\\')) return { kind: 'notice', text };
            return { old: old++, next: next++, kind: 'context', text };
          });
          if (!Number.isSafeInteger(old) || !Number.isSafeInteger(next)) throw Error();
          return { old: hunk.oldStart, next: hunk.newStart, lines };
        }),
      })),
    };
  } catch {
    return { fallback: 'Malformed or unsupported unified patch. Showing recorded source.' };
  }
}
