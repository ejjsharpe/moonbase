import { maximumRecentFiles, maximumRecentUnits } from "@escode/contracts";
import { useRef, useState } from "react";
import type { WorkspaceState, ViewMemory } from "../host/workspace";
export let memory: WorkspaceState;
export function initialize(state: WorkspaceState) {
  memory = state;
}
export function rememberProjectUse(project: string, checkout?: string) {
  const previous = memory.projectUse?.find(p => p.project === project);
  memory.projectUse = [{ project, ...(checkout ? { checkout } : previous?.checkout ? { checkout: previous.checkout } : {}) },
    ...(memory.projectUse ?? []).filter(p => p.project !== project)];
  void persist();
}
export function rememberFileUse(root: string, path: string) {
  if (!path || root.length > 4096 || path.length > 4096) return;
  const next = [{ root, path }, ...(memory.recentFiles ?? []).filter(f => f.root !== root || f.path !== path)];
  let units = 0;
  memory.recentFiles = next.slice(0, maximumRecentFiles).filter(f => {
    units += f.root.length + f.path.length;
    return units <= maximumRecentUnits;
  });
  void persist();
}
let pending: Promise<unknown> = Promise.resolve();
let failure: unknown;
let scheduled: ReturnType<typeof setTimeout> | undefined;
let writeScheduled: (() => void) | undefined;
export function persist() {
  if (scheduled) clearTimeout(scheduled);
  if (!writeScheduled) {
    pending = new Promise<void>((resolve, reject) => {
      writeScheduled = () => {
        scheduled = undefined;
        writeScheduled = undefined;
        window.escode.lifecycle("persist", structuredClone(memory)).then(() => {
          failure = undefined; resolve();
        }, error => {
          failure = error;
          window.dispatchEvent(new CustomEvent("recovery-error", { detail: String(error) }));
          reject(error);
        });
      };
    });
    void pending.catch(() => {});
  }
  scheduled = setTimeout(() => writeScheduled?.(), 150);
  return pending;
}
export async function flush() {
  if (scheduled) clearTimeout(scheduled);
  writeScheduled?.();
  await pending;
  if (failure) throw failure;
}
export function useMemory<K extends keyof ViewMemory>(
  key: string,
  field: K,
  fallback: NonNullable<ViewMemory[K]>,
) {
  const [value, setValue] = useState<NonNullable<ViewMemory[K]>>(
    () => (memory.views[key]?.[field] as NonNullable<ViewMemory[K]>) ?? fallback,
  );
  const current = useRef(value);
  const update = (
    next:
      | NonNullable<ViewMemory[K]>
      | ((old: NonNullable<ViewMemory[K]>) => NonNullable<ViewMemory[K]>),
  ) => {
    const result = typeof next === "function" ? next(current.current) : next;
    current.current = result;
    memory.views[key] = { ...memory.views[key], [field]: result };
    void persist();
    setValue(result);
  };
  return [value, update] as const;
}
export const closers = new Map<string, { project: string; capture: () => import("./close-preservation").CloseCapture | null }>();

// One exact checkout target; lookup must validate scope before calling this client path.
export type FileOpenRequest = {
  root: string;
  path: string;
  view: "file" | "staged" | "unstaged" | "untracked";
  intent: "preview" | "keep";
  current?: () => boolean;
};
// Ordering can promote without changing the selected file/view or issuing a host read.
export const fileKeepers = new Map<string, (path: string) => void>();
export function keepFileOpen(root: string, path: string) { fileKeepers.get(root)?.(path); }
export const fileOpeners = new Map<string, (request: FileOpenRequest) => Promise<boolean>>();
export async function openFile(request: FileOpenRequest) {
  const open = fileOpeners.get(request.root);
  if (!open) throw Error("The exact checkout editor is not open.");
  return open(request);
}

// Session-only navigation references; operation reconciliation may update paths in place.
export type ClosedFile = {
  path: string;
  index: number;
  view: NonNullable<ViewMemory["fileViews"]>[string];
  positions?: NonNullable<ViewMemory["editorPositions"]>[string];
};
export type FileCloseAction = { files: ClosedFile[]; active: string };
export const recentlyClosedFiles = new Map<string, FileCloseAction[]>();
export const fileCloseHistoryLimit = 20;
