import type { WorkspaceState } from "./workspace";
import type { SavedFile } from "./file-operations";
import type { Intent } from "./file-operation-journal";
export const affected = (path: string, source: string) =>
  path === source || path.startsWith(source + "/");
export const moved = (path: string, source: string, destination: string) =>
  affected(path, source) ? destination + path.slice(source.length) : path;
export function reconcileSave(state: WorkspaceState, root: string, saved: SavedFile) {
  for (const draft of state.drafts)
    if (draft.root === root && draft.path === saved.path) draft.disk = saved.disk;
}
export function reconcile(state: WorkspaceState, intent: Intent) {
  const { root, source, destination, kind } = intent;
  if (kind === "save") {
    if (intent.savedDisk) reconcileSave(state, root, { path: source, disk: intent.savedDisk });
    return;
  }
  if (kind === "copy") {
    for (const draft of intent.copies ?? []) {
      if (!state.drafts.some((d) => d.root === root && d.path === draft.path))
        state.drafts.push({ ...draft });
    }
    return;
  }
  if (!intent.preserveDrafts) state.drafts = state.drafts.flatMap((d) =>
    d.root !== root || !affected(d.path, source)
      ? [d]
      : kind === "trash"
        ? []
        : [{ ...d, path: moved(d.path, source, destination) }],
  );
  const view = state.views[root];
  if (view) {
    for (const field of ["path", "directory", "preview"] as const) {
      if (view[field] && affected(view[field], source))
        view[field] = kind === "trash" ? "" : moved(view[field], source, destination);
    }
    if (view.openFiles) view.openFiles = view.openFiles.flatMap(p =>
      kind === "trash" && affected(p, source) ? [] : [moved(p, source, destination)]);
    const mapFiles = <T>(values: Record<string, T>) => Object.fromEntries(Object.entries(values).flatMap(([p, value]) =>
      kind === "trash" && affected(p, source) ? [] : [[moved(p, source, destination), value]]));
    if (view.fileViews) view.fileViews = mapFiles(view.fileViews);
    if (view.editorPositions) view.editorPositions = mapFiles(view.editorPositions);
    if (view.files) {
      const map = (paths: string[]) =>
        paths.flatMap((p) =>
          kind === "trash" && affected(p, source)
            ? []
            : [kind === "move" ? moved(p, source, destination) : p],
        );
      view.files = {
        ...view.files,
        expanded: map(view.files.expanded),
        selected: map(view.files.selected),
        focus: map([view.files.focus])[0] ?? source.split("/").slice(0, -1).join("/"),
        scrollAnchor: view.files.scrollAnchor && map([view.files.scrollAnchor.path])[0]
          ? { ...view.files.scrollAnchor, path: map([view.files.scrollAnchor.path])[0] } : undefined,
      };
    }
    if (view.change && affected(view.change.path, source)) delete view.change;
  }
}
