import type { BufferState } from "./file-activation";
import type { ViewMemory, WorkspaceState } from "../host/workspace";
import { memory, persist, flush } from "./workspace";

export type CloseFile = {
  root: string;
  path: string;
  buffer?: BufferState;
  save: () => Promise<boolean | undefined>;
};
export type CloseCapture = { files: CloseFile[]; release: () => void };
type Publication = {
  view?: { root: string; value: ViewMemory };
  projects?: WorkspaceState["projects"];
  selected?: string;
  removeDrafts?: { root: string; path: string }[];
};

export async function preserveClose(
  files: CloseFile[],
  publication: () => Publication,
  finish: () => Promise<void> = async () => {},
) {
  const discards: CloseFile[] = [];
  for (const file of files) {
    const buffer = file.buffer;
    if (!buffer || buffer.model.getValue() === buffer.disk.text) continue;
    const choice = await window.escode.lifecycle("dirty", file.root + "/" + file.path);
    if (choice === 2) return false;
    if (choice === 1) discards.push(file);
    else if (!(await file.save())) return false;
  }
  await persist();
  await flush();
  // Snapshot after choices: completed Saves remain facts if a later step fails.
  const change = publication();
  const previousView = change.view && memory.views[change.view.root];
  const previousProjects = memory.projects, previousSelected = memory.selected;
  const removed = [...discards, ...(change.removeDrafts ?? [])];
  const affected = (draft: { root: string; path: string }) => removed.some(file => file.root === draft.root && file.path === draft.path);
  const previousDrafts = memory.drafts.filter(affected);
  try {
    memory.drafts = memory.drafts.filter(draft => !affected(draft));
    if (change.view) memory.views[change.view.root] = change.view.value;
    if (change.projects) memory.projects = change.projects;
    if (change.selected !== undefined) memory.selected = change.selected;
    await persist();
    await finish();
  } catch (error) {
    if (change.view) {
      if (previousView) memory.views[change.view.root] = previousView;
      else delete memory.views[change.view.root];
    }
    if (change.projects) memory.projects = previousProjects;
    if (change.selected !== undefined) memory.selected = previousSelected;
    memory.drafts = [...memory.drafts.filter(draft => !affected(draft)), ...previousDrafts];
    void persist();
    throw error;
  }
  for (const { buffer } of discards) buffer!.model.setValue(buffer!.disk.text);
  return true;
}
