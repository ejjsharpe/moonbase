import { isPathAtOrInside } from '@moonbase/contracts/paths';
import { compareMatches, matchPath } from '@moonbase/contracts/lookup';
import type { CommandInput, LookupMatch } from '@moonbase/contracts/workspace';

// The faux workspace's file lookup and text search, over one checkout's files, with the
// workspace host's ranking and limits.

/** A checkout's files and folders by path, as the faux workspace holds them. */
export type FauxFiles = ReadonlyMap<string, { text: string; directory: boolean }>;

// The workspace host's own matcher, so lookups rank here as they do on disk.
const match = (path: string, query: string) => matchPath(path, query) ?? undefined;
const isIgnored = (ignored: readonly string[] | undefined, path: string) =>
  !!ignored?.some((item) => isPathAtOrInside(path, item));

/** `lookupFiles` over `files`: ranked matches, then the matching history. */
export function lookupFauxFiles(
  files: FauxFiles,
  ignored: readonly string[] | undefined,
  { query, limit = 100, history = [] }: Omit<CommandInput<'lookupFiles'>, 'checkout'>,
) {
  const isFile = (path: string) => files.has(path) && !files.get(path)!.directory;
  const recent = [...new Set(history)]
    .filter(isFile)
    .map((path) => match(path, query))
    .filter((row): row is LookupMatch => !!row);
  const matches = query.trim()
    ? [...files.keys()]
        .filter((path) => isFile(path) && !isIgnored(ignored, path) && !history.includes(path))
        .map((path) => match(path, query))
        .filter((row): row is LookupMatch => !!row)
        .sort(compareMatches)
    : [];
  return {
    matches: matches.slice(0, Math.max(1, Math.min(limit, 100))),
    history: recent.slice(0, 100),
    partial: matches.length > limit || recent.length > 100,
  };
}

/** `searchText` over `files`; undefined for an invalid regular expression. */
export function searchFauxFiles(
  files: FauxFiles,
  ignored: readonly string[] | undefined,
  { query, matchCase, wholeWord, regex }: Omit<CommandInput<'searchText'>, 'checkout'>,
) {
  let pattern: RegExp;
  try {
    const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = new RegExp(wholeWord ? `\\b(?:${source})\\b` : source, matchCase ? 'g' : 'gi');
  } catch {
    return undefined;
  }
  let capped = false;
  const found = [...files]
    .filter(([path, entry]) => !entry.directory && !isIgnored(ignored, path))
    .map(([path, entry]) => {
      // The same limits as the workspace: 512-character lines, 64 ranges, 50 matches a file.
      const lines = entry.text.split('\n').map((line) => line.slice(0, 512));
      const matches = lines.flatMap((text, index) => {
        const ranges = [...text.matchAll(pattern)]
          .map((hit) => ({ start: hit.index, end: hit.index + hit[0].length }))
          .filter((range) => range.end > range.start)
          .slice(0, 64);
        return ranges.length
          ? [
              {
                line: index + 1,
                text,
                ranges,
                before: lines.slice(Math.max(0, index - 3), index),
                after: lines.slice(index + 1, index + 4),
              },
            ]
          : [];
      });
      if (matches.length > 50) capped = true;
      return { path, matches: matches.slice(0, 50) };
    })
    .filter((file) => file.matches.length)
    .sort((a, b) => a.path.localeCompare(b.path));
  return { files: found.slice(0, 200), partial: capped || found.length > 200 };
}
