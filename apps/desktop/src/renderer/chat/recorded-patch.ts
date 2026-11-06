import { parsePatch } from 'diff';
import { fitsStructuredSource } from './source-limits.ts';

export type PatchLine = {
  old?: number;
  next?: number;
  kind: 'added' | 'removed' | 'context' | 'notice';
  text: string;
  /** The line's UTF-16 offset in the patch source. */
  start?: number;
};
export type ParsedPatch =
  | {
      files: {
        old: string;
        next: string;
        hunks: { old: number; next: number; lines: PatchLine[] }[];
      }[];
    }
  | { fallback: string };

/** Interpret retained unified source only. No filesystem or edit reconstruction. */
export function parseRecordedPatch(source: string, complete = true): ParsedPatch {
  if (!complete) return { fallback: 'Incomplete patch source. Read more to view its hunks.' };
  if (!fitsStructuredSource(source))
    return { fallback: 'Large patch. Showing recorded source without parsing.' };
  try {
    // jsdiff can silently zero an unfulfilled count at bare EOF.
    const patches = parsePatch(source.endsWith('\n') ? source : source + '\n');
    if (!patches.length || !patches.every((patch) => patch.hunks.length)) throw Error();
    let cursor = 0;
    const locate = (text: string) => {
      const start = findSourceLine(source, text, cursor);
      if (start !== undefined) cursor = start + text.length;
      return start;
    };
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
            const start = locate(text);
            if (text.startsWith('+')) return { next: next++, kind: 'added', text, start };
            if (text.startsWith('-')) return { old: old++, kind: 'removed', text, start };
            if (text.startsWith('\\')) return { kind: 'notice', text, start };
            return { old: old++, next: next++, kind: 'context', text, start };
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
/** The offset of the next whole source line equal to `text`, from `cursor`. */
function findSourceLine(source: string, text: string, cursor: number) {
  for (let at = source.indexOf(text, cursor); at >= 0; at = source.indexOf(text, at + 1)) {
    const after = source[at + text.length];
    if ((at === 0 || source[at - 1] === '\n') && (after === undefined || '\r\n'.includes(after)))
      return at;
  }
  return undefined;
}
