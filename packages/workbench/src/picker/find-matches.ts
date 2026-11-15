import type { TextMatch } from '@moonbase/contracts/workspace';
import type { TextSearchSnapshot } from '@moonbase/application/editor';

/** A Find result: one matching line in one file. */
export type FindMatch = { key: string; path: string; match: TextMatch };

/** The files Find lists, with each match keyed by path and line, in list order. */
export function listFindMatches(found: TextSearchSnapshot['files']) {
  return found.map((file) => ({
    path: file.path,
    matches: file.matches.map((match): FindMatch => ({
      key: file.path + ':' + match.line,
      path: file.path,
      match,
    })),
  }));
}

/** Where opening a match puts the cursor: its first range, 1-based. */
export function findMatchPosition({ match }: FindMatch) {
  const [range] = match.ranges;
  return {
    line: match.line,
    column: (range?.start ?? 0) + 1,
    length: range ? range.end - range.start : 0,
  };
}
