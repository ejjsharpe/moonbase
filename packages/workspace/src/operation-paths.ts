import { basename, join } from 'node:path';

/**
 * The checkout paths an operation touches: its sources, and where each lands. A batch lands
 * each item in `destination` under its name; `sourceNames` names the items when the operation
 * names no source paths (a native import's files).
 */
export function getOperationPaths(
  input: { sources: { target: { path: string } }[]; destination?: string | undefined },
  sourceNames: string[] = input.sources.map((source) => basename(source.target.path)),
) {
  const sources = input.sources.map((source) => source.target.path);
  const destination = input.destination;
  if (destination === undefined) return sources;
  return [
    ...sources,
    ...(sourceNames.length > 1
      ? sourceNames.map((name) => (name ? join(destination, name) : destination))
      : [destination]),
  ];
}
