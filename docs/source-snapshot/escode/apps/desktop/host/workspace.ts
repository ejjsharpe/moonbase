import type { DurableState } from "./durable-state";
import { maximumRecentFiles, maximumRecentUnits } from "@escode/contracts";
import { isAbsolute } from "node:path";
export type WorkspaceState = import("@escode/contracts").Mutable<import("@escode/contracts").WorkspaceState>;
export type RecoveryDraft = WorkspaceState["drafts"][number];
export type ViewMemory = WorkspaceState["views"][string];
export type FilesMemory = NonNullable<ViewMemory["files"]>;
export type RestoredStatus = {
  project: string;
  root: string;
  branch: string;
  changes: import("./project").Change[];
  gitError?: string;
  approvalRequired?: boolean;
};
export interface LifecycleBridge {
  (
    operation: "load",
  ): Promise<{ state: WorkspaceState; restored: RestoredStatus[]; errors: string[]; acknowledgementRoots?: string[] }>;
  (operation: "persist", state: WorkspaceState): Promise<void>;
  (operation: "dirty", path: string): Promise<0 | 1 | 2>;
  (operation: "prepare", project?: string): Promise<boolean>;
  (operation: "finish", project?: string): Promise<void>;
}
export const emptyWorkspace = (): WorkspaceState => ({
  projects: [],
  selected: "",
  views: {},
  drafts: [],
});
function validate(value: unknown): asserts value is WorkspaceState {
  const s = value as WorkspaceState;
  if (
    !s ||
    (s.sidebarWidth !== undefined && (!Number.isFinite(s.sidebarWidth) || s.sidebarWidth < 190 || s.sidebarWidth > 380)) ||
    !Array.isArray(s.projects) ||
    !Array.isArray(s.drafts) ||
    typeof s.selected !== "string" ||
    !s.views ||
    typeof s.views !== "object" ||
    Array.isArray(s.views)
  )
    throw Error("Invalid workspace");
  if (
    (s.savedProjects !== undefined && !Array.isArray(s.savedProjects)) ||
    (s.agentsChat !== undefined && typeof s.agentsChat !== "string") ||
    [...s.projects, ...(s.savedProjects ?? [])].some(
      (p) =>
        !p ||
        typeof p.project !== "string" ||
        !isAbsolute(p.project) ||
        typeof p.root !== "string" ||
        !isAbsolute(p.root),
    )
  )
    throw Error("Invalid project memory");
  if (s.projectUse !== undefined && (
    !Array.isArray(s.projectUse) || s.projectUse.some(p => !p || typeof p.project !== "string" || !isAbsolute(p.project)
      || (p.checkout !== undefined && (typeof p.checkout !== "string" || !isAbsolute(p.checkout))))
    || new Set(s.projectUse.map(p => p.project)).size !== s.projectUse.length
  )) throw Error("Invalid project use");
  if (new Set(s.projects.map(p => p.root)).size !== s.projects.length)
    throw Error("Duplicate checkout memory");
  if (s.recentFiles !== undefined) {
    if (!Array.isArray(s.recentFiles) || s.recentFiles.length > maximumRecentFiles) throw Error("Invalid recent files");
    let units = 0;
    const targets = new Set<string>();
    for (const entry of s.recentFiles) {
      if (!entry || typeof entry.root !== "string" || !isAbsolute(entry.root) || entry.root.length > 4096 || entry.root.includes("\0") ||
        typeof entry.path !== "string" || !entry.path || entry.path.length > 4096 || isAbsolute(entry.path) || entry.path.includes("\0") ||
        entry.path.split("/").some(c => !c || c === "." || c === ".." || c.toLowerCase() === ".git")) throw Error("Invalid recent files");
      units += entry.root.length + entry.path.length;
      const key = JSON.stringify([entry.root, entry.path]);
      if (units > maximumRecentUnits || targets.has(key)) throw Error("Invalid recent files");
      targets.add(key);
    }
  }
  for (const d of s.drafts) {
    if (
      !d ||
      typeof d.root !== "string" ||
      !isAbsolute(d.root) ||
      typeof d.path !== "string" ||
      !d.path ||
      isAbsolute(d.path) ||
      d.path.split("/").includes("..") ||
      typeof d.text !== "string" ||
      typeof d.disk?.text !== "string" ||
      typeof d.disk.version !== "string"
    )
      throw Error("Invalid recovery draft");
  }
  for (const v of Object.values(s.views)) {
    const validFile = (p: string) => typeof p === "string" && !!p && !isAbsolute(p) &&
      !p.split("/").some(c => !c || c === "." || c === ".." || c.toLowerCase() === ".git");
    const views = ["file", "staged", "unstaged", "untracked", "conflict"];
    const record = (x: unknown) => !!x && typeof x === "object" && !Array.isArray(x);
    if (v?.preview !== undefined && v.preview !== "" &&
      (!validFile(v.preview) || !v.openFiles?.includes(v.preview))) throw Error("Invalid preview");
    if (v?.fileViews !== undefined && (!record(v.fileViews) ||
      Object.entries(v.fileViews).some(([p, selected]) => !validFile(p) || !views.includes(selected))))
      throw Error("Invalid file views");
    if (v?.editorPositions !== undefined && (!record(v.editorPositions) ||
      Object.entries(v.editorPositions).some(([p, positions]) => !validFile(p) || !record(positions) ||
        Object.entries(positions).some(([selected, pos]) =>
          !views.includes(selected.replace(/:original$/, "")) || !record(pos) ||
          !Number.isInteger(pos.line) || pos.line < 1 || !Number.isInteger(pos.column) || pos.column < 1 ||
          !Number.isFinite(pos.top) || pos.top < 0 || !Number.isFinite(pos.left) || pos.left < 0))))
      throw Error("Invalid editor positions");
    if (v?.openFiles !== undefined &&
      (!Array.isArray(v.openFiles) || new Set(v.openFiles).size !== v.openFiles.length ||
        v.openFiles.some(p => !validFile(p)) ||
        (v.path && !v.openFiles.includes(v.path))))
      throw Error("Invalid open files");
    if (
      v?.files !== undefined &&
      (!v.files ||
        typeof v.files !== "object" ||
        !Array.isArray(v.files.expanded) ||
        !Array.isArray(v.files.selected) ||
        [...v.files.expanded, ...v.files.selected, v.files.focus].some(
          (p) =>
            typeof p !== "string" ||
            p.startsWith("/") ||
            p.split("/").some((c) => c === ".." || c.toLowerCase() === ".git"),
        ) ||
        (v.files.hideIgnored !== undefined && typeof v.files.hideIgnored !== "boolean") ||
        (v.files.scrollAnchor !== undefined && (!v.files.scrollAnchor ||
          !validFile(v.files.scrollAnchor.path) || !Number.isFinite(v.files.scrollAnchor.offset) || v.files.scrollAnchor.offset < 0)) ||
        !Number.isFinite(v.files.scroll) ||
        v.files.scroll < 0)
    )
      throw Error("Invalid Files memory");
    if (
      !v ||
      typeof v !== "object" ||
      (v.mode !== undefined && !["Files", "Source Control", "Chats"].includes(v.mode)) ||
      [v.checkout, v.path, v.directory, v.chat].some(
        (x) => x !== undefined && typeof x !== "string",
      ) ||
      (v.roots !== undefined &&
        (!Array.isArray(v.roots) || v.roots.some((x) => typeof x !== "string"))) ||
      (v.change !== undefined &&
        (typeof v.change.path !== "string" ||
          !["staged", "unstaged", "untracked"].includes(v.change.area)))
    )
      throw Error("Invalid view memory");
  }
}
export class Workspace {
  private queue: Promise<unknown> = Promise.resolve();
  private revision?: number;
  private approvalRevision = 0;
  constructor(private file: string, readonly owner: { hostId: string; clientId: string }, readonly database: DurableState) {}

  private async readApprovals(): Promise<{ project: string; root: string; directoryIdentity?: string }[]> {
    try {
      const stored = await this.database.recoveryRead(this.owner.hostId, "approvals");
      this.approvalRevision = stored.revision;
      const value = stored.body ?? [];
      if (
        !Array.isArray(value) ||
        value.some(
          (p) =>
            !p ||
            typeof p.project !== "string" ||
            !isAbsolute(p.project) ||
            typeof p.root !== "string" ||
            !isAbsolute(p.root) ||
            (p.directoryIdentity !== undefined && !/^\d+:\d+$/.test(p.directoryIdentity)),
        )
      )
        throw Error("Invalid project approvals. Existing data is retained.");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  async approved() {
    await this.queue;
    return this.readApprovals();
  }
  async validateCheckout(root: string, identity: string) {
    const approved = (await this.approved()).find(p => p.root === root);
    if (approved && !approved.directoryIdentity)
      throw Error("Checkout identity was not recorded. Use Open project to approve the original directory.");
    if (approved?.directoryIdentity && approved.directoryIdentity !== identity)
      throw Error("Checkout directory was replaced. Restore the original directory.");
  }
  approve(project: string, root: string, directoryIdentity?: string) {
    return this.change(async () => {
      if (!isAbsolute(project) || !isAbsolute(root)) throw Error("Invalid project approval");
      const approved = await this.readApprovals();
      if (directoryIdentity !== undefined && !/^\d+:\d+$/.test(directoryIdentity))
        throw Error("Invalid checkout identity");
      const previous = approved.find((p) => p.project === project && p.root === root);
      if (previous?.directoryIdentity && directoryIdentity && previous.directoryIdentity !== directoryIdentity)
        throw Error("Checkout identity changed. Restore the original directory.");
      if (!previous || directoryIdentity && !previous.directoryIdentity) {
        if (previous) previous.directoryIdentity = directoryIdentity;
        else approved.push({ project, root, ...(directoryIdentity ? { directoryIdentity } : {}) });
        await this.database.recoveryWrite(this.owner.hostId, "approvals", approved, this.approvalRevision);
      }
    });
  }
  async read(): Promise<WorkspaceState> {
    await this.queue;
    try {
      const stored = await this.database.recoveryRead(this.owner.clientId, "workspace");
      this.revision = stored.revision;
      const state: unknown = stored.body ?? emptyWorkspace();
      validate(state);
      for (const view of Object.values(state.views)) {
        if (!view.files) {
          const ancestors = (path: string) => {
            const parts = path.split("/").filter(Boolean);
            return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
          };
          view.files = {
            expanded: [
              ...new Set([
                ...ancestors(view.directory || ""),
                ...ancestors((view.path || "").split("/").slice(0, -1).join("/")),
              ]),
            ],
            selected: view.path ? [view.path] : [],
            focus: view.path || view.directory || "",
            scroll: 0,
          };
        }
      }
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyWorkspace();
      throw error;
    }
  }
  write(state: unknown, reconcileState?: (state: WorkspaceState) => void) {
    return this.change(async () => {
      validate(state);
      reconcileState?.(state);
      await this.replace(this.file, state);
    });
  }
  private change(edit: () => Promise<void>) {
    const task = this.queue.then(edit);
    this.queue = task.catch(() => {});
    return task;
  }
  private async replace(file: string, value: unknown) {
    if (file === this.file) {
      if (this.revision === undefined) this.revision = (await this.database.recoveryRead(this.owner.clientId, "workspace")).revision;
      await this.database.recoveryWrite(this.owner.clientId, "workspace", value, this.revision);
      this.revision++;
      return;
    }
    throw Error("Unknown workspace persistence target");
  }
}
