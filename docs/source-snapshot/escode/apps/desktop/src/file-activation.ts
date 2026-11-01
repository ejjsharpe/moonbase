import type * as monaco from "monaco-editor";
import type { Document } from "../host/project";
import { memory, rememberFileUse } from "./workspace";

export type BufferState = {
  model: monaco.editor.ITextModel;
  disk: Document;
  view?: monaco.editor.ICodeEditorViewState | null;
};
type View = "file" | "conflict" | "staged" | "unstaged" | "untracked";
type Comparison = { original: string; modified: string; title: string; file?: string };
type Activation = {
  file: string;
  view: View;
  intent?: "preview" | "keep";
  diff: Comparison | null;
  conflict?: { path: string; disk: Document } | null;
  message?: string;
  fileError?: string;
  comparisonError?: string;
};
type Open = {
  file: string;
  view?: View;
  intent?: "preview" | "keep";
  retain?: boolean;
  reuseBuffer?: boolean;
  current?: () => boolean;
};

export function createFileActivation({ root, buffers, addBuffer, apply, report }: {
  root: string;
  buffers: Map<string, BufferState>;
  addBuffer: (file: string, disk: Document) => BufferState;
  apply: (result: Activation) => void;
  report: (error: unknown) => void;
}) {
  let generation = 0, pending = 0;
  const checkpoint = () => {
    const captured = generation;
    return () => captured === generation;
  };
  async function load(file: string, current: () => boolean, revalidate: boolean) {
    if (revalidate || !buffers.has(file)) {
      const disk = await window.escode.project("read", root, file);
      if (!current()) return;
      const buffer = buffers.get(file);
      if (!buffer) addBuffer(file, disk);
      else if (buffer.model.getValue() === buffer.disk.text) {
        buffer.disk = disk;
        if (buffer.model.getValue() !== disk.text) buffer.model.setValue(disk.text);
      }
      return disk;
    }
    return buffers.get(file)!.disk;
  }
  function compare(file: string, disk: Document) {
    generation++;
    apply({ file, view: "conflict", diff: { original: disk.text,
      modified: buffers.get(file)!.model.getValue(), title: "Disk versus your edits", file } });
  }
  async function open({ file, view = "file", intent, retain = false, reuseBuffer = false, current: scope = () => true }: Open) {
    generation++;
    const latest = checkpoint();
    const current = () => latest() && scope();
    pending++;
    try {
      let diff: Comparison | null = null;
      let conflict: Activation["conflict"];
      let message = "Cmd+S to save.";
      if (view === "file" || view === "conflict") {
        const disk = await load(file, current, view === "conflict" || retain && !reuseBuffer);
        if (!current() || !disk) return false;
        if (view === "conflict") {
          conflict = buffers.get(file)!.disk.version === disk.version ? null : { path: file, disk };
          diff = { original: disk.text, modified: buffers.get(file)!.model.getValue(), title: "Disk versus your edits", file };
          message = "Disk versus your edits";
        }
      } else {
        const value = await window.escode.project("diff", root, file, view);
        if (!current()) return false;
        let working: string | undefined;
        try {
          await load(file, current, !reuseBuffer && !!buffers.get(file) &&
            buffers.get(file)!.model.getValue() === buffers.get(file)!.disk.text);
          if (!current()) return false;
          working = file;
        } catch (error) {
          message = "Working file unavailable; comparison is read-only. " + String(error);
        }
        diff = { ...value, file: working, title: view + " · " + file + (working && view === "staged" ? " · working copy" : "") };
        if (working) message = "Edit the new side · Cmd+S to save the working file.";
      }
      if (!current()) return false;
      if (!diff || diff.file) rememberFileUse(root, file);
      if (view !== "file" && view !== "conflict") memory.views[root] = { ...memory.views[root], change: { path: file, area: view } };
      apply({ file, view, intent, diff, conflict, message });
      return true;
    } catch (error) {
      if (!current()) return false;
      const selected = memory.views[root];
      if (retain || view === "conflict" || selected?.path === file && selected.fileViews?.[file] === view) {
        const unavailable = (view === "file" ? "File unavailable. Available edits are retained. " : "Comparison unavailable. ") + String(error);
        apply({ file, view, diff: null, message: String(error),
          ...(view === "file" ? { fileError: unavailable } : { comparisonError: unavailable }) });
      }
      report(error);
      return false;
    } finally { pending--; }
  }
  return {
    open, compare, checkpoint,
    invalidate() { generation++; },
    restore(file: string, reuseBuffer = false) {
      return open({ file, view: memory.views[root]?.fileViews?.[file] ?? "file", retain: true, reuseBuffer });
    },
    async refresh() {
      const selected = memory.views[root];
      const view = selected?.fileViews?.[selected.path ?? ""];
      if (!pending && selected?.path && view && view !== "file" && view !== "conflict")
        await open({ file: selected.path, view });
    },
  };
}
