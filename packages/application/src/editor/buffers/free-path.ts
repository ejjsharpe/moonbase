/**
 * A path beside `path` that `taken` doesn't hold, for unsaved text kept apart from its file:
 * `notes (unsaved).md`, then `notes (unsaved 2).md` and so on.
 */
export function findFreePath(path: string, taken: ReadonlySet<string>) {
  const slash = path.lastIndexOf('/') + 1,
    name = path.slice(slash),
    dot = name.lastIndexOf('.'),
    stem = dot > 0 ? name.slice(0, dot) : name,
    extension = dot > 0 ? name.slice(dot) : '';
  for (let copy = 1; ; copy++) {
    const candidate =
      path.slice(0, slash) + stem + (copy === 1 ? ' (unsaved)' : ` (unsaved ${copy})`) + extension;
    if (!taken.has(candidate)) return candidate;
  }
}
