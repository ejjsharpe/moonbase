import { uiProps } from "./ui/props";
import { controls } from "./ui/controls";
import { workbench } from "./ui/workbench";
import { chatUI } from "./ui/chat";
import { overlays } from "./ui/overlays";
import { colors, type } from "./ui/tokens.stylex";
import { RetentionSettings } from "./retention-settings";
import { SidebarProvider, SidebarResize } from "./sidebar";
import { preserveClose } from "./close-preservation";
import { createFileActivation } from "./file-activation";
import type { BufferState } from "./file-activation";
import React, { useEffect, useId, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as stylex from "@stylexjs/stylex";
import { Button } from "@base-ui/react/button";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import CssWorker from "monaco-editor/language/css/css.worker.js?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import TypeScriptWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
import type { Change, Document, SaveResult, ProjectBridge } from "../host/project";
import { affected, moved, reconcile, reconcileSave } from "../host/file-operation-state";
import { FileLookup } from "./file-lookup";
import { FilesTree } from "./files";
import { AgentsView } from "./agents";
import { ChatView } from "./chat";
import { useProjectChats } from "./chat-state";
import { WorktreeChoices } from "./worktrees";
import type { ChatBridge } from "./chat";
import "./ui/reset.css";
import { memory, initialize, persist, flush, useMemory, closers, rememberProjectUse, fileOpeners, fileKeepers, openFile, recentlyClosedFiles, fileCloseHistoryLimit } from "./workspace";
document.documentElement.className = stylex.props(workbench.document).className ?? "";
type Status = {
  project: string;
  root: string;
  branch: string;
  changes: Change[];
  gitError?: string;
  approvalRequired?: boolean;
};
declare global {
  interface Window {
    escode: {
      lifecycle: import("../host/workspace").LifecycleBridge;
      onClose(callback: () => void): () => void;
      chat: ChatBridge;
      chatLive: (project: string | null, id: string, apply: (value: import("@escode/contracts").ChatDetail) => void, error: (message: string) => void) => () => void;
      sendState: (project: string | null, id: string) => Promise<{ admissionEpoch: string; expected: string }>;
      sendMessage: (command: import("@escode/contracts").SendCommand) => Promise<unknown>;
      sendStatus: (commandId: string) => Promise<unknown>;
      checkpointRetention: (days?: number | null) => Promise<number | null>;
      checkpointPoints: (project: string | null, id: string, cursor: string | null) => Promise<import("@escode/contracts").CheckpointPage>;
      rewind: (project: string | null, id: string, boundary: string, token: string | null, commandId: string | null, restoreFiles?: boolean) => Promise<import("@escode/contracts").RewindResult>;
      branchHistory: (project: string | null, id: string, boundary: string, token: string | null, commandId: string | null, summarized?: boolean) => Promise<import("@escode/contracts").RewindResult>;
      inspectFiles: (project: string | null, id: string, boundary: string, path: string | null, cursor: string | null) => Promise<import("@escode/contracts").FileInspection>;
      inspectBoundary: (project: string | null, id: string, boundary: string, cursor: string | null) => Promise<import("@escode/contracts").BoundaryInspection>;
      chatHistory: (project: string | null, id: string, cursor: string | null) => Promise<import("@escode/contracts").HistoryPage>;
      chatSummaries: (apply: (value: import("@escode/contracts").ChatSummaries) => void, error: (message: string) => void) => () => void;
      copyConversationCode(text: string): Promise<void>;
      toolStatus(): Promise<unknown>;
      project: ProjectBridge;
      observeFiles(root: string, notify: (error?: string, ready?: boolean) => void): () => void;
      searchFiles(root: string, query: string, apply: (result: import("@escode/contracts").LookupResult) => void, error: (message: string) => void, history?: readonly string[]): () => void;
      lookupFile(root: string, query: string): Promise<string>;
      listDirectory(root: string, path: string): Promise<import("@escode/contracts").DirectoryResult>;
      watchFiles(root: string, paths: string[], callback: (error?: string, ready?: boolean) => void): () => void;
      nativeFiles(files: File[]): Promise<string>;
    };
    MonacoEnvironment: { getWorker(_: string, label: string): Worker };
  }
}
window.MonacoEnvironment = {
  getWorker: (_id, label) => {
    if (label === "json") return new JsonWorker();
    if (["css", "scss", "less"].includes(label)) return new CssWorker();
    if (["html", "handlebars", "razor"].includes(label)) return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TypeScriptWorker();
    return new EditorWorker();
  },
};
monaco.editor.defineTheme("escode", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": colors.canvas,
    "editor.foreground": colors.text,
    "editorLineNumber.foreground": colors.muted,
    "editorLineNumber.activeForeground": colors.secondary,
    "editor.lineHighlightBackground": colors.surface,
    "editor.selectionBackground": colors.selection,
    "editorCursor.foreground": colors.accent,
    "editorWidget.background": colors.elevated,
    "editorWidget.border": colors.controlBorder,
  },
});
function CheckoutView({
  root,
  project,
  active,
  mode,
  onStatus,
  onBlocked,
  navigation,
}: {
  root: string;
  project: string;
  active: boolean;
  mode: string;
  navigation: React.ReactNode;
  onStatus: (status: Status) => void;
  onBlocked: (root: string, blocked: boolean) => void;
}) {
  const projectCall = window.escode.project;
  const editorVisible = mode !== "Chats";
  const container = useRef<HTMLDivElement>(null);
  const buffers = useRef(new Map<string, BufferState>());
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [checkoutError, setCheckoutError] = useState("");
  const [filesRevision, setFilesRevision] = useState(0);
  const [transferProgress, setTransferProgress] = useState(false);
  const [path, setPath] = useMemory(root, "path", "");
  const [openFiles, setOpenFiles] = useMemory(root, "openFiles", [
    ...new Set([...(memory.views[root]?.path ? [memory.views[root].path!] : []),
      ...memory.drafts.filter(d => d.root === root).map(d => d.path)]),
  ]);
  const tabStrip = useRef<HTMLDivElement>(null);
  const draggedTab = useRef<string | null>(null);
  const recentFiles = useRef<string[]>(path ? [path] : []);
  const pickerId = useId();
  const pickerElement = useRef<HTMLDivElement>(null);
  const pickerSession = useRef<{ files: string[]; index: number; focus: HTMLElement | null } | null>(null);
  const [picker, setPicker] = useState<{ files: string[]; index: number } | null>(null);
  const content = useRef<HTMLElement>(null);
  const focusAfterClose = useRef(false);
  const [tabMenu, setTabMenu] = useState<{ file: string; order: string[] } | null>(null);
  const replacedPreviews = useRef<string[]>([]);
  const [preview, setPreview] = useMemory(root, "preview", "");
  function tabLabel(file: string) {
    const parts = file.split("/");
    for (let count = 1; count < parts.length; count++) {
      const suffix = parts.slice(-count).join("/");
      if (!openFiles.some(other => other !== file && other.split("/").slice(-count).join("/") === suffix)) return suffix;
    }
    return file;
  }
  function tabDirty(file: string) {
    const buffer = buffers.current.get(file);
    return !!buffer && buffer.model.getValue() !== buffer.disk.text;
  }
  useEffect(() => {
    const row = tabStrip.current;
    if (!row || !active || !editorVisible) return;
    const reveal = () => row.querySelector('[aria-selected="true"]')?.closest(".file-tab")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(row);
    return () => observer.disconnect();
  }, [path, openFiles, active, editorVisible]);
  function keepOpen(file: string) {
    if (memory.views[root]?.preview === file) setPreview("");
  }
  function activateFile(file: string, intent?: "preview" | "keep") {
    recentFiles.current = [file, ...recentFiles.current.filter(p => p !== file)];
    const existing = memory.views[root]?.openFiles?.includes(file);
    const previous = memory.views[root]?.preview;
    if (intent === "keep") keepOpen(file);
    let replaced = "";
    if (!existing && intent === "preview") {
      if (previous && previous !== file) {
        const buffer = buffers.current.get(previous);
        if (!buffer || buffer.model.getValue() === buffer.disk.text) {
          replaced = previous;
          replacedPreviews.current.push(previous);
        }
      }
      setPreview(file);
    }
    setOpenFiles(old => {
      if (old.includes(file)) return old;
      const next = [...old];
      next.splice(next.indexOf(memory.views[root]?.path ?? "") + 1, 0, file);
      return next.filter(p => p !== replaced);
    });
    setPath(file);
  }
  const [fileViews, setFileViews] = useMemory(root, "fileViews", {});
  const view = fileViews[path] ?? "file";
  const viewRef = useRef({ path, view });
  viewRef.current = { path, view };
  const [comparisonError, setComparisonError] = useState("");
  const [fileError, setFileError] = useState("");
  function rememberView(file: string, selected: typeof view) {
    setFileViews(old => ({ ...old, [file]: selected }));
    setComparisonError("");
    setFileError("");
  }
  const [message, setMessage] = useState("Open a local Git checkout to begin.");
  const [conflict, setConflict] = useState<{ path: string; disk: Document } | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ file: string; current: () => boolean } | null>(null);
  const [diff, setDiff] = useState<{ original: string; modified: string; title: string; file?: string } | null>(
    null,
  );
  const [bufferRevision, setBufferRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [, updateText] = useState(0);
  const [saving, setSaving] = useState(false);
  const [fileClosing, setFileClosing] = useState(false);
  const closeInFlight = useRef(false);
  const transferNavigation = useRef(false);
  useEffect(
    () => onBlocked(root, !!conflict || saving || fileClosing),
    [conflict, saving, fileClosing, root, onBlocked],
  );
  const saveInFlight = useRef(false);
  const saveAction = useRef<() => void>(() => {});
  const report = (error: unknown) =>
    setMessage(error instanceof Error ? error.message : String(error));
  const statusRequest = useRef(0);
  const statusRefreshing = useRef(false);
  const refresh = async () => {
    if (statusRefreshing.current) return;
    statusRefreshing.current = true;
    try {
      const request = ++statusRequest.current;
      let value: Status;
      try {
        value = await projectCall("status", root);
        if (request !== statusRequest.current) return;
        setCheckoutError("");
      } catch (error) {
        if (request !== statusRequest.current) return;
        setCheckoutError(
          "Checkout unavailable. Restore access to the original directory, then Retry checkout. Edits and chat associations are retained. " +
            String(error),
        );
        throw error;
      }
      setStatus(value);
      onStatus(value);
      if (!closeInFlight.current) await activation.refresh();
    } finally { statusRefreshing.current = false; }
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (active && (e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        saveAction.current();
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
    };
  }, [active]);
  function record(file: string, b: BufferState) {
    memory.drafts = memory.drafts.filter((d) => d.root !== root || d.path !== file);
    if (b.model.getValue() !== b.disk.text)
      memory.drafts.push({ root, path: file, text: b.model.getValue(), disk: b.disk });
    return persist();
  }
  function addBuffer(file: string, disk: Document, text = disk.text) {
    const b: BufferState = {
      disk,
      model: monaco.editor.createModel(text, undefined, monaco.Uri.file(root + "/" + file)),
    };
    buffers.current.set(file, b);
    b.model.onDidChangeContent(() => {
      if (b.model.getValue() !== b.disk.text) keepOpen(file);
      void record(file, b);
      updateText(old => old + 1);
    });
    return b;
  }
  useEffect(() => {
    for (const d of memory.drafts.filter((d) => d.root === root)) {
      keepOpen(d.path);
      addBuffer(d.path, d.disk, d.text);
    }
    setOpenFiles(old => [...new Set([...old, ...memory.drafts.filter(d => d.root === root).map(d => d.path)])]);
    if (path) void restoreView(path);
    return () => {
      activation.invalidate();
      fileOpeners.delete(root);
      fileKeepers.delete(root);
      closers.delete(root);
    };
  }, []);
  useEffect(
    () => () => {
      for (const b of buffers.current.values()) b.model.dispose();
    },
    [],
  );
  useEffect(() => {
    void refresh().catch(report);
    return () => { statusRequest.current++; };
  }, []);
  useEffect(() => {
    if (!status) return;
    const id = setInterval(() => void refresh().catch(report), 2000);
    return () => clearInterval(id);
  }, [status?.root, mode]);
  useEffect(() => {
    if (!editorVisible || !container.current || !path || diff || view !== "file") return;
    const b = buffers.current.get(path);
    if (!b) return;
    const instance = monaco.editor.create(container.current, {
      model: b.model,
      readOnly: closeInFlight.current || saveInFlight.current,
      automaticLayout: true,
      theme: "escode",
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: type.mono,
      padding: { top: 16, bottom: 16 },
      accessibilitySupport: "on",
      editContext: false,
      ariaLabel: path + " editor",
    });
    container.current.dataset.modelUri = b.model.uri.toString();
    container.current.dataset.language = b.model.getLanguageId();
    editor.current = instance;
    if (b.view) instance.restoreViewState(b.view);
    const position = trackPosition(instance, path, "file");
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveAction.current());
    const update = () => setDirty(b.model.getValue() !== b.disk.text);
    update();
    const listener = b.model.onDidChangeContent(update);
    return () => {
      listener.dispose();
      position();
      b.view = instance.saveViewState();
      instance.dispose();
      editor.current = null;
    };
  }, [path, diff, view, bufferRevision, editorVisible]);
  useEffect(() => {
    if (!editorVisible || !diff || !container.current) return;
    const original = monaco.editor.createModel(diff.original, "plaintext");
    const buffer = diff.file ? buffers.current.get(diff.file) : undefined;
    const modified = buffer?.model ?? monaco.editor.createModel(diff.modified, "plaintext");
    const instance = monaco.editor.createDiffEditor(container.current, {
      readOnly: !buffer || closeInFlight.current || saveInFlight.current,
      originalEditable: false,
      automaticLayout: true,
      theme: "escode",
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: type.mono,
      padding: { top: 16, bottom: 16 },
      renderSideBySide: false,
      accessibilitySupport: "on",
      editContext: false,
      domReadOnly: !buffer,
      originalAriaLabel: diff.title + " original",
      modifiedAriaLabel: diff.title + " modified",
    });
    instance.setModel({ original, modified });
    // Monaco's initial diff option pass clears the side labels.
    instance.getOriginalEditor().updateOptions({
      ariaLabel: diff.title + " original",
      readOnly: true,
      domReadOnly: true,
    });
    const modifiedEditor = instance.getModifiedEditor();
    const position = trackPosition(modifiedEditor, path, view);
    const originalPosition = trackPosition(instance.getOriginalEditor(), path, view + ":original");
    modifiedEditor.updateOptions({ ariaLabel: diff.title + " modified" });
    if (buffer) editor.current = modifiedEditor;
    modifiedEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveAction.current());
    const update = () => setDirty(!!buffer && modified.getValue() !== buffer.disk.text);
    update();
    const listener = modified.onDidChangeContent(update);
    return () => {
      listener.dispose();
      position();
      originalPosition();
      if (editor.current === modifiedEditor) editor.current = null;
      instance.dispose();
      original.dispose();
      if (!buffer) modified.dispose();
    };
  }, [diff, path, view, editorVisible]);
  useEffect(() => {
    if (fileClosing || !focusAfterClose.current || !active || !editorVisible) return;
    const frame = requestAnimationFrame(() => {
      focusAfterClose.current = false;
      if (path && editor.current) editor.current.focus();
      else content.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [fileClosing, path, diff, bufferRevision, active, editorVisible]);
  // These effects run after the editors above detach from replaced models.
  useEffect(() => {
    for (const file of replacedPreviews.current.splice(0)) {
      if (memory.views[root]?.openFiles?.includes(file)) continue;
      buffers.current.get(file)?.model.dispose();
      buffers.current.delete(file);
    }
  }, [openFiles]);
  useEffect(() => {
    if (focusRequest && focusRequest.current() &&
      memory.views[root]?.path === focusRequest.file && container.current?.getClientRects().length)
      (editor.current ?? content.current)?.focus();
  }, [focusRequest, editorVisible, active]);
  function trackPosition(instance: monaco.editor.ICodeEditor, file: string, selected: string) {
    const stored = memory.views[root]?.editorPositions?.[file]?.[selected];
    if (stored) {
      instance.setPosition({ lineNumber: stored.line, column: stored.column });
      instance.setScrollPosition({ scrollTop: stored.top, scrollLeft: stored.left });
    }
    const recordPosition = () => {
      if (!memory.views[root]?.openFiles?.includes(file)) return;
      const cursor = instance.getPosition();
      if (!cursor) return;
      const positions = memory.views[root]?.editorPositions ?? {};
      memory.views[root] = { ...memory.views[root], editorPositions: { ...positions,
        [file]: { ...positions[file], [selected]: { line: cursor.lineNumber, column: cursor.column,
          top: instance.getScrollTop(), left: instance.getScrollLeft() } } } };
      void persist();
    };
    const cursor = instance.onDidChangeCursorPosition(recordPosition);
    const scroll = instance.onDidScrollChange(recordPosition);
    return () => { recordPosition(); cursor.dispose(); scroll.dispose(); };
  }
  const [activation] = useState(() => createFileActivation({
    root, buffers: buffers.current, addBuffer, report,
    apply(result) {
      activateFile(result.file, result.intent);
      rememberView(result.file, result.view);
      setDiff(old => old?.title === result.diff?.title && old?.original === result.diff?.original &&
        old?.modified === result.diff?.modified && old?.file === result.diff?.file ? old : result.diff);
      if (result.conflict !== undefined) setConflict(result.conflict);
      setFileError(result.fileError ?? "");
      setComparisonError(result.comparisonError ?? "");
      setBufferRevision(old => old + 1);
      if (result.message !== undefined) setMessage(result.message);
    },
  }));
  const restoreView = activation.restore;
  const compareConflict = activation.compare;
  async function save(version?: string, target = path) {
    if (!target || saveInFlight.current) return false;
    const b = buffers.current.get(target)!;
    const text = b.model.getValue();
    saveInFlight.current = true;
    setSaving(true);
    try {
      const result: SaveResult = await projectCall(
        "save",
        root,
        target,
        text,
        version ?? b.disk.version,
      );
      if (result.kind === "conflict") {
        if (target !== path) {
          activateFile(target);
          rememberView(target, "file");
          setDiff(null);
        }
        setConflict({ path: target, disk: result.disk });
        setMessage("Disk changed. Compare, overwrite this disk version, or reload.");
      } else {
        if (result.persistencePending) {
          setMessage(result.message ?? "Saved on disk; recovery requires restart. Available edits retained.");
          return false;
        }
        b.disk = result.disk;
        if (target === viewRef.current.path) setDirty(b.model.getValue() !== b.disk.text);
        setConflict(null);
        if (viewRef.current.view === "conflict") compareConflict(target, result.disk);
        await record(target, b);
        await refresh();
        setMessage("Saved " + target);
        return b.model.getValue() === b.disk.text;
      }
    } catch (e) {
      report(e);
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }
  saveAction.current = () => {
    if (!closeInFlight.current && (!diff || diff.file)) void save(undefined, diff?.file ?? path);
  };
  async function reload() {
    if (!conflict) return;
    try {
      const disk: Document = await projectCall("read", root, conflict.path);
      const b = buffers.current.get(conflict.path)!;
      b.disk = disk;
      b.model.setValue(disk.text);
      setConflict(null);
      if (view === "conflict") compareConflict(conflict.path, disk);
      setDirty(false);
      await record(conflict.path, b);
      setMessage("Reloaded from disk.");
    } catch (e) {
      report(e);
    }
  }
  function captureFiles(files: Iterable<string>) {
    return Array.from(files, file => ({ root, path: file, buffer: buffers.current.get(file),
      save: async () => {
        const saved = await save(undefined, file);
        if (!saved) window.dispatchEvent(new CustomEvent("reveal-file", { detail: { project, root } }));
        return saved;
      },
    }));
  }
  async function closeFiles(files: string[]) {
    if (saveInFlight.current || closeInFlight.current || conflict) return false;
    const targets = new Set(files.filter(file => memory.views[root]?.openFiles?.includes(file)));
    if (!targets.size) return true;
    closeInFlight.current = true;
    activation.invalidate();
    setFileClosing(true);
    editor.current?.updateOptions({ readOnly: true });
    const activeFile = memory.views[root]?.path ?? "";
    try {
      let previous = memory.views[root];
      let remaining: string[] = [], survivor = "";
      const closed = await preserveClose(captureFiles(targets), () => {
        previous = memory.views[root];
        remaining = (previous?.openFiles ?? []).filter(file => !targets.has(file));
        survivor = targets.has(activeFile)
          ? recentFiles.current.find(file => remaining.includes(file)) ?? remaining[0] ?? ""
          : activeFile;
        return {
          view: { root, value: { ...previous, openFiles: remaining, path: survivor,
            preview: targets.has(previous?.preview ?? "") ? "" : previous?.preview ?? "" } },
          removeDrafts: [...targets].map(path => ({ root, path })),
        };
      });
      if (!closed) return false;
      const history = recentlyClosedFiles.get(root) ?? [];
      history.push({ active: targets.has(activeFile) ? activeFile : [...targets].at(-1)!,
        files: (previous?.openFiles ?? []).flatMap((file, index) => targets.has(file) ? [{
          path: file, index, view: previous?.fileViews?.[file] ?? "file",
          positions: structuredClone(previous?.editorPositions?.[file]),
        }] : []),
      });
      recentlyClosedFiles.set(root, history.slice(-fileCloseHistoryLimit));
      setOpenFiles(remaining);
      setPreview(memory.views[root]?.preview ?? "");
      recentFiles.current = recentFiles.current.filter(file => !targets.has(file));
      if (targets.has(activeFile)) {
        setPath(survivor);
        setDiff(null);
        setConflict(null);
        setDirty(false);
        if (survivor) await restoreView(survivor);
      }
      for (const file of targets) {
        buffers.current.get(file)?.model.dispose();
        buffers.current.delete(file);
      }
      return true;
    } catch (error) {
      report(error);
      return false;
    } finally {
      closeInFlight.current = false;
      setFileClosing(false);
      editor.current?.updateOptions({ readOnly: false });
      focusAfterClose.current = true;
    }
  }
  async function reopenClosedFiles() {
    const history = recentlyClosedFiles.get(root);
    const action = history?.at(-1);
    if (!action || closeInFlight.current || saveInFlight.current || conflict) return;
    closeInFlight.current = true;
    setFileClosing(true);
    try {
      const current = memory.views[root];
      const order = [...(current?.openFiles ?? [])];
      const existing = new Set(order);
      const views = { ...current?.fileViews };
      const positions = { ...current?.editorPositions };
      for (const file of action.files) {
        if (existing.has(file.path)) continue;
        order.splice(Math.min(file.index, order.length), 0, file.path);
        views[file.path] = file.view;
        if (file.positions) positions[file.path] = structuredClone(file.positions);
      }
      memory.views[root] = { ...current, editorPositions: positions };
      setFileViews(views);
      setOpenFiles(order);
      setDiff(null);
      await restoreView(action.active, existing.has(action.active));
      await persist();
      history!.pop();
    } catch (error) { report(error); }
    finally {
      closeInFlight.current = false;
      setFileClosing(false);
      editor.current?.updateOptions({ readOnly: false });
      focusAfterClose.current = true;
    }
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const reopen = event.shiftKey && event.key.toLowerCase() === "t";
      const close = !event.shiftKey && event.key.toLowerCase() === "w";
      if (!active || !editorVisible || !event.metaKey || event.ctrlKey || event.altKey || (!close && !reopen)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("dialog, [role=dialog], [role=alertdialog], [role=menu]") ||
        (target?.closest("input, textarea, select, [contenteditable=true]") && !target.closest(".monaco-editor"))) return;
      event.preventDefault();
      event.stopPropagation();
      if (!closeInFlight.current && !saveInFlight.current && !conflict) {
        if (reopen) void reopenClosedFiles();
        else void closeFiles(path ? [path] : []);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });
  function cancelPicker(restoreFocus = true) {
    const session = pickerSession.current;
    pickerSession.current = null;
    setPicker(null);
    if (restoreFocus && session)
      (session.focus?.isConnected ? session.focus : editor.current ?? content.current)?.focus();
  }
  function commitPicker() {
    const session = pickerSession.current;
    if (!session) return;
    cancelPicker(false);
    const file = session.files[session.index]!;
    if (!memory.views[root]?.openFiles?.includes(file)) return;
    void restoreView(file).then(success => {
      if (success) setFocusRequest({ file, current: activation.checkpoint() });
      else content.current?.focus();
    });
  }
  useEffect(() => {
    if (picker) {
      pickerElement.current?.focus();
      pickerElement.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    }
  }, [picker]);
  useEffect(() => {
    if (!active || !editorVisible || saving || fileClosing || conflict) cancelPicker(false);
  }, [active, editorVisible, saving, fileClosing, conflict]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (pickerSession.current && event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); cancelPicker(); return;
      }
      if (!active || !editorVisible || closeInFlight.current || saveInFlight.current || conflict || tabMenu) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("dialog, [role=dialog], [role=alertdialog], [role=menu]") ||
        (target?.closest("input, textarea, select, [contenteditable=true]") && !target.closest(".monaco-editor"))) return;
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === "Tab") {
        event.preventDefault(); event.stopPropagation();
        const files = memory.views[root]?.openFiles ?? [];
        if (!files.length) return;
        const session = pickerSession.current ?? {
          files: [...new Set([path, ...recentFiles.current, ...files])].filter(file => files.includes(file)),
          index: 0, focus: document.activeElement as HTMLElement | null,
        };
        session.index = (session.index + (event.shiftKey ? session.files.length - 1 : 1)) % session.files.length;
        pickerSession.current = session;
        setPicker({ files: session.files, index: session.index });
      } else if (!pickerSession.current && event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault(); event.stopPropagation();
        const files = memory.views[root]?.openFiles ?? [];
        if (!files.length) return;
        const next = (files.indexOf(path) + (event.key === "ArrowRight" ? 1 : files.length - 1)) % files.length;
        const file = files[next]!;
        const stripFocus = !!target?.closest(".file-tabs");
        void restoreView(file).then(success => {
          if (!success) return;
          if (stripFocus) Array.from(tabStrip.current?.querySelectorAll<HTMLButtonElement>("[role=tab]") ?? [])
            .find(tab => tab.title === root + "/" + file)?.focus();
          else setFocusRequest({ file, current: activation.checkpoint() });
        });
      }
    };
    const release = (event: KeyboardEvent) => {
      if (event.key === "Control" && pickerSession.current) {
        event.preventDefault(); event.stopPropagation(); commitPicker();
      }
    };
    const blur = () => cancelPicker(false);
    const focus = (event: FocusEvent) => {
      if (pickerSession.current && !pickerElement.current?.contains(event.target as Node)) cancelPicker(false);
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("keyup", release, true);
    window.addEventListener("blur", blur);
    window.addEventListener("focusin", focus);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("keyup", release, true);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focusin", focus);
    };
  });
  function dismissTabMenu() {
    const file = tabMenu?.file;
    setTabMenu(null);
    const tabs = content.current?.querySelectorAll<HTMLButtonElement>("[role=tab]");
    Array.from(tabs ?? []).find(tab => tab.title === root + "/" + file)?.focus();
  }
  async function fileOperation(
    kind: "move" | "trash" | "paste" | "duplicate" | "drag-move" | "drag-copy" | "import",
    source: string | string[],
    destination = "",
    inline = false,
  ) {
    const transferring =
      kind === "paste" ||
      kind === "duplicate" ||
      kind === "drag-move" ||
      kind === "drag-copy" ||
      kind === "import";
    if (closeInFlight.current || saveInFlight.current || conflict) {
      if (inline || transferring) throw Error("Finish the pending file action first.");
      return;
    }
    const sources = typeof source === "string" ? [source] : [...source];
    const single = sources[0];
    closeInFlight.current = true;
    setFileClosing(!transferring);
    setTransferProgress(transferring);
    transferNavigation.current = transferring;
    setMessage(
      transferring
        ? "Transferring files… Navigation and chat Stop remain available. Earlier move undo history resets."
        : "Applying file operation…",
    );
    editor.current?.updateOptions({ readOnly: true });
    try {
      for (const [file, b] of buffers.current) {
        memory.drafts = memory.drafts.filter((d) => d.root !== root || d.path !== file);
        if (b.model.getValue() !== b.disk.text)
          memory.drafts.push({ root, path: file, text: b.model.getValue(), disk: b.disk });
      }
      await persist();
      await flush();
      if (
        kind === "move" &&
        Array.from(buffers.current.keys()).some(
          (f) =>
            affected(
              f.normalize("NFC").toLowerCase(),
              destination.normalize("NFC").toLowerCase(),
            ) && !affected(f, single),
        )
      )
        throw Error("Destination has open buffers. Close them or choose another path.");
      const batch =
        kind === "trash"
          ? await projectCall("trash-selection", root, sources)
          : transferring
            ? await projectCall("transfer", root, kind, destination, sources)
            : null;
      transferNavigation.current = false;
      const results = batch
        ? batch.results
        : [
            {
              source: single,
              ...(await projectCall(
                "file-operation",
                root,
                inline ? "rename" : "move",
                single,
                inline ? destination.split("/").at(-1)! : destination,
              )),
            },
          ];
      for (const saved of batch && "saves" in batch ? batch.saves : []) {
        const b = buffers.current.get(saved.path);
        if (b) b.disk = saved.disk;
        reconcileSave(memory, root, saved);
      }
      let nextPath = memory.views[root]?.path ?? path;
      const reconciliationNotes: string[] = [];
      for (const result of results) {
        if (!result.applied || !result.intent) continue;
        const source = result.intent.source;
        const target = result.intent.destination;
        const operationKind = result.intent.kind;
        if (operationKind === "copy") {
          for (const draft of result.intent.copies ?? []) {
            const existing = buffers.current.get(draft.path);
            if (!existing) addBuffer(draft.path, draft.disk, draft.text);
            else {
              const text = existing.model.getValue();
              const clean = text === existing.disk.text;
              const current = editor.current?.getModel() === existing.model;
              const view = current ? editor.current?.saveViewState() : existing.view;
              existing.disk = draft.disk;
              if (clean || text === draft.text) {
                if (text !== draft.text) {
                  existing.model.pushStackElement();
                  existing.model.pushEditOperations(
                    [],
                    [{ range: existing.model.getFullModelRange(), text: draft.text }],
                    () => null,
                  );
                  existing.model.pushStackElement();
                }
                if (current && view) editor.current?.restoreViewState(view);
              } else {
                reconciliationNotes.push(
                  `Destination ${root}/${draft.path} changed while copying. Its current text was retained; source edits remain available at ${root}/${moved(draft.path, target, source)}. Review both before saving.`,
                );
              }
              // Match the recovery draft to the visible model, including any newer destination edits.
              void record(draft.path, existing);
            }
          }
          reconcile(memory, result.intent);
          continue;
        }
        const current = editor.current?.getModel();
        for (const [file, b] of Array.from(buffers.current)) {
          if (!affected(file, source)) continue;
          if (current === b.model && view === "file") b.view = editor.current?.saveViewState();
          buffers.current.delete(file);
          if (operationKind === "move") {
            const next = addBuffer(moved(file, source, target), b.disk, b.model.getValue());
            next.view = b.view;
          }
          b.model.dispose();
        }
        reconcile(memory, result.intent);
        // Only recorded applied outcomes may change session navigation references.
        const history = recentlyClosedFiles.get(root);
        if (history) recentlyClosedFiles.set(root, history.flatMap(action => {
          const files = action.files.flatMap(file =>
            operationKind === "trash" && affected(file.path, source) ? [] :
              [{ ...file, path: moved(file.path, source, target) }]);
          if (!files.length) return [];
          const active = operationKind === "trash" && affected(action.active, source)
            ? files.at(-1)!.path : moved(action.active, source, target);
          return [{ files, active }];
        }));
        recentFiles.current = recentFiles.current.flatMap(file =>
          operationKind === "trash" && affected(file, source) ? [] : [moved(file, source, target)]);
        nextPath =
          operationKind === "move"
            ? moved(nextPath, source, target)
            : affected(nextPath, source)
              ? ""
              : nextPath;
      }
      setPreview(memory.views[root]?.preview ?? "");
      setOpenFiles(memory.views[root]?.openFiles ?? []);
      setPath(nextPath);
      setDiff(null);
      setFileViews(memory.views[root]?.fileViews ?? {});
      if (nextPath) void restoreView(nextPath);
      setBufferRevision((n) => n + 1);
      setDirty(
        !!buffers.current.get(nextPath) &&
          buffers.current.get(nextPath)!.model.getValue() !==
            buffers.current.get(nextPath)!.disk.text,
      );
      let completionError = "";
      try {
        await persist();
        // Never acknowledge before the reconciled state has reached durable storage.
        if (batch?.requiresAck || (!batch && results.some((r) => r.applied)))
          await projectCall("file-operation-ack", root);
      } catch (error) {
        completionError = `\nRecovery persistence/acknowledgement failed; restart to reconcile available intent: ${String(error)}`;
      }
      setFilesRevision((n) => n + 1);
      let refreshError = "";
      try {
        await refresh();
      } catch (error) {
        refreshError = `\nRefresh failed: ${String(error)}`;
      }
      if (batch && "open" in batch) for (const file of batch.open) {
        // Completion owns the serialization gate; external opens remain blocked.
        if (await activation.open({ file, intent: "keep" }))
          setFocusRequest({ file, current: activation.checkpoint() });
      }
      const failed = batch && "saves" in batch ? batch.results.find((r) => r.conflict) : undefined;
      if (failed?.conflict) {
        await activation.open({ file: failed.conflict.path, intent: "keep" });
        setConflict(failed.conflict);
      }
      const message =
        [batch?.message ?? results[0].message, ...reconciliationNotes].join("\n") +
        completionError +
        refreshError;
      setMessage(message);
      if (inline && !results[0].applied) throw Error(message);
    } catch (error) {
      report(error);
      if (inline) throw error;
    } finally {
      closeInFlight.current = false;
      setFileClosing(false);
      setTransferProgress(false);
      transferNavigation.current = false;
      editor.current?.updateOptions({ readOnly: false });
    }
  }
  fileKeepers.set(root, keepOpen);
  fileOpeners.set(root, async request => {
    if (request.root !== root || (closeInFlight.current && !transferNavigation.current)) return false;
    const opened = await activation.open({ file: request.path, view: request.view, intent: request.intent, current: request.current });
    if (opened && request.intent === "keep")
      setFocusRequest({ file: request.path, current: activation.checkpoint() });
    return opened;
  });
  const open = (file: string, view: import("./workspace").FileOpenRequest["view"] = "file",
    intent: "preview" | "keep" = "keep") => openFile({ root, path: file, view, intent });
  closers.set(root, {
    project,
    capture() {
      if (closeInFlight.current || saveInFlight.current) return null;
      closeInFlight.current = true;
      setFileClosing(true);
      return { files: captureFiles(buffers.current.keys()), release() {
        closeInFlight.current = false;
        setFileClosing(false);
      } };
    },
  });
  return (
    <div {...uiProps("workspace", workbench.workspace)} hidden={!active || mode === "Chats"} inert={fileClosing}>
      <SidebarResize />
      <aside {...stylex.props(workbench.sidebar)} aria-label={mode + " sidebar"}>
        {navigation}
        {transferProgress && (
          <p {...stylex.props(controls.status, workbench.sidebarItem)} role="status">
            Transferring captured files… Navigation and chat Stop remain available.
          </p>
        )}
        {checkoutError && (
          <>
            <p {...stylex.props(controls.status, workbench.sidebarItem)} role="status">{checkoutError}</p>
            <Button {...stylex.props(controls.button, workbench.sidebarItem)}
              onClick={() =>
                void (async () => {
                  await refresh();
                  setFilesRevision((n) => n + 1);
                  if (path) await restoreView(path);
                })().catch(report)
              }
            >
              Retry checkout
            </Button>
          </>
        )}
        {status?.gitError && <p {...stylex.props(controls.status, workbench.sidebarItem)} role="status">{status.gitError}</p>}
        {status?.gitError && (
          <Button {...stylex.props(controls.button, workbench.sidebarItem)} onClick={() => void refresh().catch(report)}>Retry Git</Button>
        )}
        {status && mode === "Files" && (
          <>
            <FilesTree
              key={root}
              root={root}
              active={active}
              activePath={path}
              disabled={!!conflict || saving}
              revision={filesRevision}
              dirty={(file) => {
                const b = buffers.current.get(file);
                return !!b && b.model.getValue() !== b.disk.text;
              }}
              open={async (file, focusEditor) => {
                await open(file, "file", focusEditor ? "keep" : "preview");
              }}
              rename={(source, destination) => fileOperation("move", source, destination, true)}
              create={async (parent, name, kind) => {
                const destination = (parent ? parent + "/" : "") + name;
                if (
                  Array.from(buffers.current.keys()).some(
                    (file) =>
                      file.normalize("NFC").toLowerCase() ===
                      destination.normalize("NFC").toLowerCase(),
                  )
                )
                  throw Error("Destination has an open buffer. Close it or choose a free name.");
                const file = await projectCall("create-entry", root, parent, name, kind);
                setFilesRevision((n) => n + 1);
                if (kind === "file") await activation.open({ file, intent: "keep" });
                return file;
              }}
              transfer={async (kind, sources, parent) => {
                if (kind === "copy" || kind === "cut") {
                  setMessage(await projectCall("clipboard-capture", root, kind, sources));
                } else await fileOperation(kind, sources, parent);
              }}
              trash={async (sources) => {
                await fileOperation("trash", sources);
              }}
            />
          </>
        )}
        {status && mode === "Source Control" && (
          <>
            {(["unstaged", "staged", "untracked"] as const).map((area) => (
              <section {...stylex.props(workbench.sidebarItem)} key={area}>
                <h2 {...stylex.props(controls.heading, workbench.sectionHeading)}>{area}</h2>
                <ul {...stylex.props(controls.list)}>
                  {status.changes
                    .filter((c) => c.area === area)
                    .map((c) => (
                      <li key={c.path}>
                        <Button {...stylex.props(controls.button, controls.listButton)}
                          aria-pressed={
                            path === c.path && view === area
                          }
                          onClick={() => void open(c.path, c.area, "preview")}
                          onDoubleClick={() => void open(c.path, c.area, "keep")}
                        >
                          {c.path}
                        </Button>
                      </li>
                    ))}
                </ul>
              </section>
            ))}
          </>
        )}
        <footer {...uiProps("chat-sidebar-footer", workbench.sidebarItem, chatUI.footer)}><RetentionSettings /></footer>
      </aside>
      <section ref={content} tabIndex={-1} {...uiProps("content", workbench.content)} aria-label="Main editor">
        {mode !== "Chats" && (
          <>
            <div ref={tabStrip} {...uiProps("file-tabs", workbench.fileTabs)} role="tablist" aria-label="Open files">
              {openFiles.map(file => (
                <span key={file} {...uiProps("file-tab", workbench.fileTab)} onDragOver={event => {
                  if (!draggedTab.current || saving || fileClosing || conflict) return;
                  event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
                }} onDrop={event => {
                  const source = draggedTab.current;
                  draggedTab.current = null;
                  if (!source || saving || fileClosing || conflict) return;
                  event.preventDefault(); event.stopPropagation();
                  const order = memory.views[root]?.openFiles ?? [];
                  const from = order.indexOf(source), to = order.indexOf(file);
                  if (from < 0 || to < 0 || from === to) return;
                  const next = [...order];
                  next.splice(from, 1); next.splice(to, 0, source);
                  keepOpen(source); setOpenFiles(next);
                }}>
                <button {...stylex.props(controls.button, workbench.fileTabButton, path === file && workbench.fileSelected, preview === file && workbench.preview, tabDirty(file) && workbench.unsaved)} role="tab" tabIndex={path === file ? 0 : -1} aria-label={file} data-unsaved={tabDirty(file) || undefined} aria-selected={path === file}
                  draggable={!saving && !fileClosing && !conflict}
                  onDragStart={event => {
                    draggedTab.current = file; event.stopPropagation();
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("application/x-escode-file-tab", file);
                  }} onDragEnd={() => { draggedTab.current = null; }}
                  aria-description={[preview === file ? "Preview" : "", tabDirty(file) ? "Unsaved" : ""].filter(Boolean).join(", ") || undefined}
                  onDoubleClick={() => keepOpen(file)}
                  title={root + "/" + file} disabled={saving || fileClosing || !!conflict}
                  onContextMenu={event => {
                    event.preventDefault(); setTabMenu({ file, order: [...openFiles] });
                  }} onKeyDown={event => {
                    if (event.shiftKey && event.key === "F10") {
                      event.preventDefault(); setTabMenu({ file, order: [...openFiles] });
                    } else if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
                      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                        event.preventDefault();
                        const index = openFiles.indexOf(file);
                        const next = event.key === "Home" ? 0 : event.key === "End" ? openFiles.length - 1 :
                          (index + (event.key === "ArrowRight" ? 1 : openFiles.length - 1)) % openFiles.length;
                        tabStrip.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
                        void restoreView(openFiles[next]!);
                      } else if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        void restoreView(file).then(success => {
                          if (success) setFocusRequest({ file, current: activation.checkpoint() });
                        });
                      }
                    }
                  }} onClick={() => void restoreView(file)}>{tabLabel(file)}</button>
                <button {...stylex.props(controls.button, workbench.fileTabButton)} tabIndex={-1} aria-label={"Close " + file} disabled={saving || fileClosing || !!conflict}
                  onClick={() => void closeFiles([file])}>×</button>
                </span>
              ))}
            </div>
            {picker && <div ref={pickerElement} {...uiProps("recent-tabs", overlays.recent)} role="listbox" aria-label="Recent tabs"
              aria-description="Hold Control and press Tab or Shift+Tab to select. Release Control to open. Escape cancels."
              aria-activedescendant={pickerId + "-" + picker.index} tabIndex={-1}>
              {picker.files.map((file, index) => <div {...stylex.props(overlays.recentOption, index === picker.index && workbench.fileSelected)} key={file} id={pickerId + "-" + index}
                role="option" aria-selected={index === picker.index} title={root + "/" + file}
                aria-description={[preview === file ? "Preview" : "", tabDirty(file) ? "Unsaved" : ""].filter(Boolean).join(", ") || undefined}>
                {file}
              </div>)}
            </div>}
            {tabMenu && <div role="menu" aria-label={"File tab actions for " + tabMenu.file}
              {...uiProps("files-menu", overlays.menu)} onBlur={event => {
                if (!event.currentTarget.contains(event.relatedTarget)) setTabMenu(null);
              }} onKeyDown={event => {
                if (event.key === "Escape") { event.preventDefault(); dismissTabMenu(); }
                if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                  event.preventDefault();
                  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
                  const index = items.indexOf(document.activeElement as HTMLButtonElement);
                  items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
                    (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
                }
              }}>
              <button {...stylex.props(controls.button, overlays.menuButton)} role="menuitem" autoFocus onClick={() => { keepOpen(tabMenu.file); dismissTabMenu(); }}>Keep Open</button>
              {["Close", "Close Others", "Close to the Right", "Close All"].map(action =>
                <button {...stylex.props(controls.button, overlays.menuButton)} key={action} role="menuitem" onClick={() => {
                  const { file, order } = tabMenu;
                  const files = action === "Close" ? [file] : action === "Close Others" ? order.filter(p => p !== file) :
                    action === "Close to the Right" ? order.slice(order.indexOf(file) + 1) : order;
                  dismissTabMenu();
                  void closeFiles(files);
                }}>{action}</button>)}
            </div>}
            <div {...uiProps("toolbar", workbench.toolbar)}>
              <span {...stylex.props(controls.truncate, workbench.toolbarLabel)}>
                {diff?.title || (path && view !== "file" ? view + " · " + path : path) || "No file selected"}
                {dirty && path && (!diff || diff.file) ? " • Unsaved" : ""}
              </span>
              {path && <label>File view <select {...stylex.props(controls.field)} aria-label="File view" value={view}
                disabled={saving || fileClosing} onChange={event => {
                  const next = event.target.value;
                  if (next === "conflict" && conflict) compareConflict(path, conflict.disk);
                  else if (next === "file") void activation.open({ file: path });
                  else if (next === "staged" || next === "unstaged" || next === "untracked")
                    void activation.open({ file: path, view: next, retain: true });
                }}>
                <option value="file">File</option>
                {(["staged", "unstaged", "untracked"] as const).filter(area =>
                  area === view || status?.changes.some(c => c.path === path && c.area === area)
                ).map(area => <option key={area} value={area}>{area}</option>)}
                {(conflict || view === "conflict") && <option value="conflict">Save conflict</option>}
              </select></label>}
              {path && preview === path && <Button {...stylex.props(controls.button)} onClick={() => { keepOpen(path); editor.current?.focus(); }}>Keep Open</Button>}
              {path && buffers.current.has(path) && (
                <Button {...stylex.props(controls.button)} disabled={saving} onClick={() => void save(undefined, diff?.file ?? path)}>
                  Save ⌘S
                </Button>
              )}
              {path && (
                <Button {...stylex.props(controls.button)} disabled={saving || fileClosing} onClick={() => void closeFiles([path])}>
                  Close file
                </Button>
              )}
            </div>
            {conflict && (
              <div role="alert" {...uiProps("conflict", controls.alert, workbench.conflict)}>
                <p>{conflict.path} changed on disk. Your edits are retained.</p>
                <Button {...stylex.props(controls.button, workbench.conflictButton)}
                  disabled={saving}
                  onClick={() => compareConflict(conflict.path, conflict.disk)}
                >
                  Compare
                </Button>
                <Button {...stylex.props(controls.button, workbench.conflictButton)} disabled={saving} onClick={() => void save(conflict.disk.version, conflict.path)}>
                  Overwrite
                </Button>
                <Button {...stylex.props(controls.button, workbench.conflictButton)} disabled={saving} onClick={() => void reload()}>
                  Reload
                </Button>
                <Button {...stylex.props(controls.button, workbench.conflictButton)}
                  disabled={saving}
                  onClick={() => {
                    setConflict(null);
                    if (view === "conflict") { rememberView(path, "file"); setDiff(null); }
                  }}
                >
                  Cancel
                </Button>
              </div>
            )}
            {diff && !diff.file && !comparisonError && <Button {...stylex.props(controls.button)} onClick={() => void restoreView(path)}>Retry comparison</Button>}
            {path && fileError && <div {...stylex.props(controls.alert)} role="alert">{fileError}
              <Button {...stylex.props(controls.button)} onClick={() => void restoreView(path)}>Retry file</Button>
            </div>}
            {comparisonError && <div {...stylex.props(controls.alert)} role="alert">{comparisonError}
              <Button {...stylex.props(controls.button)} onClick={() => void restoreView(path)}>Retry comparison</Button>
            </div>}
            {diff && !comparisonError && diff.original === (diff.file ? buffers.current.get(diff.file)?.model.getValue() : diff.modified) && <p {...stylex.props(controls.status)} role="status">No changes</p>}
            <p {...stylex.props(controls.status, workbench.message)}
              role="status"
              tabIndex={0}
            >
              {message}
            </p>
            <div {...uiProps("editor", workbench.editor)} ref={container} />
          </>
        )}
      </section>
    </div>
  );
}
function ProjectView({
  initial,
  active,
  onActivity,
  onStatus,
}: {
  initial: Status;
  active: boolean;
  onActivity: (activity: string) => void;
  onStatus: (status: Status) => void;
}) {
  const checkout = initial.root;
  const [mode, setMode] = useMemory(checkout, "mode", "Files");
  const [activity, setActivity] = useState("");
  const [blocked, setBlocked] = useState<Record<string, boolean>>({});
  const onBlocked = React.useCallback(
    (root: string, value: boolean) =>
      setBlocked((old) => (old[root] === value ? old : { ...old, [root]: value })),
    [],
  );
  const [lookup, setLookup] = useState(false);
  const sidebarId = "chats-" + encodeURIComponent(checkout);
  useEffect(() => {
    const reveal = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.root === checkout) {
        setMode("Files");
      }
    };
    window.addEventListener("reveal-file", reveal);
    return () => window.removeEventListener("reveal-file", reveal);
  }, []);
  useEffect(() => {
    if (!active) setLookup(false);
    const key = (event: KeyboardEvent) => {
      if (!active || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "p" ||
          event.altKey || event.shiftKey || event.repeat || blocked[checkout] ||
          event.target instanceof HTMLInputElement ||
          document.querySelector('dialog[open], [role="dialog"], [role="menu"], .tree-edit')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setLookup(true);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [active, blocked, checkout]);
  const [chatStore, { chats }] = useProjectChats(initial.project);
  const [selectedChat, setSelectedChat] = useMemory(checkout, "chat", "");
  const chatNavigation = useRef(0);
  useEffect(() => {
    chatNavigation.current++;
  }, [active, mode]);
  const selectChat = async (id: string) => {
    chatNavigation.current++;
    const chat = chats.find((c) => c.id === id);
    if (!chat || chat.checkout !== checkout || chat.phase === "draft" && chat.worktree) return;
    setSelectedChat(id);
    await chatStore.open(id);
  };
  const createChat = async (root: string) => {
    const generation = chatNavigation.current;
    memory.views[initial.project] = { ...memory.views[initial.project], checkout };
    await persist();
    const chat = await window.escode.chat("createDraft", initial.project, root);
    await chatStore.load();
    if (chatNavigation.current !== generation) return;
    if (root !== checkout) {
      memory.agentsChat = chat.id;
      await persist();
      window.dispatchEvent(new Event("draft-context-changed"));
      return;
    }
    setSelectedChat(chat.id);
    await chatStore.open(chat.id);
  };
  useEffect(() => {
    const all = chats.filter(c => c.checkout === checkout);
    const value = all.some((s) => s.needsInput)
      ? "Needs input"
      : all.some((s) => s.busy)
        ? "Running"
        : "";
    setActivity(value);
    onActivity(value);
  }, [chats, onActivity]);
  const navigation = (
      <nav {...uiProps("view-nav", workbench.viewNav)} aria-label="Project views">
        {["Files", "Source Control", "Chats"].map((view) => (
          <Button {...stylex.props(controls.button, workbench.viewButton, mode === view && workbench.activeView)}
            key={view}
            disabled={blocked[checkout]}
            aria-pressed={mode === view}
            onClick={(event) => {
              const section = event.currentTarget.closest("section");
              setMode(view);
              // Chats uses a separate sidebar; move focus to its visible control.
              requestAnimationFrame(() => {
                const buttons = section?.querySelectorAll<HTMLButtonElement>(".view-nav button[aria-pressed=true]");
                Array.from(buttons ?? []).find(button => button.offsetParent !== null)?.focus();
              });
            }}
          >
            <svg {...stylex.props(controls.icon)} aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d={view === "Files" ? "M5 3h9l5 5v13H5Z M14 3v6h5" : view === "Chats" ? "M3 4h18v13H9l-6 4Z" : "M8 3v18 M4 7l4-4 4 4 M16 21V3 M12 17l4 4 4-4"} /></svg>
            {view === "Source Control" ? "Diff" : view}
            {view === "Chats" && activity ? " · " + activity : ""}
          </Button>
        ))}
        <span {...uiProps("directory", workbench.directory, workbench.navDirectory)} title={checkout}>
          Checkout: {initial.branch} · {checkout}
        </span>
      </nav>
  );
  return (
    <section {...stylex.props(workbench.project)} hidden={!active} aria-label={initial.project}>
        {lookup && active && <FileLookup root={checkout} project={initial.project} onClose={() => setLookup(false)} />}
        <CheckoutView
          key={checkout}
          root={checkout}
          project={initial.project}
          mode={mode}
          navigation={navigation}
          active={active}
          onBlocked={onBlocked}
          onStatus={onStatus}
        />
      <div {...uiProps("workspace", workbench.workspace)} hidden={mode !== "Chats"}>
        <SidebarResize />
        <aside {...stylex.props(workbench.sidebar)} id={sidebarId}>{navigation}</aside>
        <section {...uiProps("content", workbench.content)}>
          <div {...uiProps("chat-panel", chatUI.chatPanel)}>
            <div {...uiProps("chat-view", chatUI.chatView)}>
              <div {...uiProps("chat-conversation", chatUI.conversation)}>
                <WorktreeChoices
                  project={initial.project}
                  createChat={createChat}
                  onRemoved={() => chatStore.load()}
                />
                {active && mode === "Chats" && (
                  <ChatView
                    project={initial.project}
                    checkout={checkout}
                    sidebarId={sidebarId}
                    selected={selectedChat}
                    select={selectChat}
                    createChat={createChat}
                  />
                )}
              </div>
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}
function App({ restored, errors }: { restored: Status[]; errors: string[] }) {
  const [projects, setProjects] = useState<Status[]>(restored);
  const [agentsLookup, setAgentsLookup] = useState(false);
  const [selected, setSelected] = useState(memory.selected || "agents");
  useEffect(() => {
    if (selected !== "agents") setAgentsLookup(false);
    const key = (event: KeyboardEvent) => {
      if (selected !== "agents" || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "p" ||
          event.altKey || event.shiftKey || event.repeat || event.target instanceof HTMLInputElement ||
          document.querySelector('dialog[open], [role="dialog"], [role="menu"], .tree-edit')) return;
      event.preventDefault(); event.stopImmediatePropagation(); setAgentsLookup(true);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [selected]);
  useEffect(() => {
    const moved = () => setSelected("agents");
    window.addEventListener("draft-context-changed", moved);
    return () => window.removeEventListener("draft-context-changed", moved);
  }, []);
  const [activity, setActivity] = useState<Record<string, string>>({});
  const [error, setError] = useState(errors.join("\n"));
  const [closing, setClosing] = useState(false);
  const closeInFlight = useRef(false);
  async function close(root?: string) {
    if (closeInFlight.current) return;
    closeInFlight.current = true;
    setClosing(true);
    try {
      const project = root ? projects.find(p => p.root === root)?.project : undefined;
      if (root && !project) return;
      if (!(await window.escode.lifecycle("prepare", project))) return;
      const captures: import("./close-preservation").CloseCapture[] = [];
      try {
        for (const [checkout, entry] of closers) {
          if (root && checkout !== root) continue;
          const capture = entry.capture();
          if (!capture) return;
          captures.push(capture);
        }
        const closed = await preserveClose(captures.flatMap(capture => capture.files), () => {
          if (!root) return {};
          const remaining = memory.projects.filter(p => p.root !== root);
          const index = memory.projects.findIndex(p => p.root === root);
          return { projects: remaining, selected: memory.selected === root
            ? remaining[Math.min(index, remaining.length - 1)]?.root ?? "agents" : memory.selected };
        }, () => window.escode.lifecycle("finish", project));
        if (!closed) return;
      } finally { for (const capture of captures) capture.release(); }
      if (project) {
        setProjects((old) => old.filter((p) => p.root !== root));
        setSelected(memory.selected);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      closeInFlight.current = false;
      setClosing(false);
    }
  }
  function selectCheckout(target: { project: string; root: string }) {
    rememberProjectUse(target.project, target.root);
    setSelected(target.root);
  }
  useEffect(() => window.escode.onClose(() => void close()), [projects]);
  useEffect(() => {
    const reveal = (event: Event) => {
      const target = (event as CustomEvent).detail;
      if (memory.projects.some(p => p.root === target.root && p.project === target.project)) selectCheckout(target);
    };
    window.addEventListener("reveal-file", reveal);
    const listener = (event: Event) =>
      setError("Recovery draft could not be saved: " + (event as CustomEvent).detail);
    window.addEventListener("recovery-error", listener);
    return () => {
      window.removeEventListener("recovery-error", listener);
      window.removeEventListener("reveal-file", reveal);
    };
  }, []);
  useEffect(() => {
    memory.selected = selected;
    void persist();
  }, [selected]);
  useEffect(() => {
    const openCheckout = (event: Event) => { void open((event as CustomEvent).detail); };
    window.addEventListener("open-checkout", openCheckout);
    return () => window.removeEventListener("open-checkout", openCheckout);
  }, []);
  const updateStatus = React.useCallback((value: Status) => {
    setProjects(old => old.map(p => p.root === value.root && p.branch !== value.branch ? value : p));
  }, []);
  const callbacks = useRef(new Map<string, (value: string) => void>());
  async function open(target?: { project: string; id: string }) {
    try {
      const value = target
        ? await window.escode.project("open-checkout", target.project, target.id)
        : await window.escode.project("open");
      if (!value) return;
      setError("");
      setProjects((old) => old.some(p => p.root === value.root)
        ? old.map(p => p.root === value.root ? value : p) : [...old, value]);
      if (!memory.projects.some(p => p.root === value.root))
        memory.projects.push({ project: value.project, root: value.root });
      memory.savedProjects ??= [];
      if (!memory.savedProjects.some((p) => p.project === value.project))
        memory.savedProjects.push({ project: value.project, root: value.root });
      selectCheckout(value);
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <SidebarProvider><main {...stylex.props(workbench.page)} data-agents={selected === "agents"} inert={closing}>
      <nav {...uiProps("project-tabs", workbench.projectTabs)} aria-label="Projects">
        <Button {...stylex.props(controls.button, workbench.tabButton, workbench.agentsTab, selected === "agents" && workbench.selectedTab)} aria-pressed={selected === "agents"} onClick={() => setSelected("agents")}>
          <svg {...stylex.props(controls.icon)} aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" /></svg>
          Agents
        </Button>
        {projects.map((p) => (
          <div {...uiProps("project-tab", workbench.projectTab, selected === p.root && workbench.activeProject)} key={p.root} data-active={selected === p.root}>
          <Button {...stylex.props(controls.button, workbench.tabButton, workbench.projectButton, selected === p.root && workbench.selectedTab)}
            key={p.root}
            aria-label={p.project.split("/").at(-1) + (projects.filter(other => other.project === p.project).length > 1 ? " · " + p.branch + " · " + p.root : "") + (activity[p.root] ? " · " + activity[p.root] : "")}
            aria-description={`${p.branch} · ${p.root}`}
            aria-pressed={selected === p.root}
            title={`${p.project} · ${p.branch} · ${p.root} · Middle-click or press Delete to close editor`}
            onAuxClick={(event) => {
              if (event.button === 1) void close(p.root);
            }}
            onKeyDown={(event) => {
              if (event.key === "Delete" || event.key === "Backspace") {
                event.preventDefault();
                void close(p.root);
              }
            }}
            onClick={() => selectCheckout(p)}
          >
            <svg {...stylex.props(controls.icon)} aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m12 3 9 5v8l-9 5-9-5V8Z M3 8l9 5 9-5 M12 13v8" /></svg>
            <span {...uiProps("project-tab-name", controls.truncate)}>{p.project.split("/").at(-1)}{projects.filter(other => other.project === p.project).length > 1 ? ` · ${p.branch} · ${p.root.split("/").at(-1)}` : ""}</span>
            {activity[p.root] && <span {...uiProps("project-tab-activity", workbench.activity)} title={activity[p.root]} aria-label={activity[p.root]} />}
          </Button>
          <Button {...uiProps("project-tab-close", controls.button, workbench.tabClose, workbench.tabButton)} aria-label={`Close ${p.project.split("/").at(-1)} project`} aria-description={`${p.branch} · ${p.root}`} title={`Close checkout editor · ${p.root}`} onClick={() => void close(p.root)}>
            <svg {...stylex.props(controls.icon)} aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m4 4 8 8 M12 4l-8 8" /></svg>
          </Button>
          </div>
        ))}
        <Button {...uiProps("project-tab-open", controls.button, workbench.tabOpen, workbench.tabButton)} aria-label="Open project…" title="Open project…" onClick={() => void open()}>
          <svg {...stylex.props(controls.icon)} aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 5v14 M5 12h14" /></svg>
        </Button>
      <header {...stylex.props(workbench.header)}><span {...uiProps("workspace-context", controls.hidden)}>{selected}</span></header>
      </nav>
      {error && <p {...stylex.props(controls.alert)} role="alert">{error}</p>}
      {selected === "agents" && <>
        <AgentsView />
        {agentsLookup && <FileLookup roots={projects} onClose={() => setAgentsLookup(false)} />}
      </>}
      {projects.map((p) => {
        if (!callbacks.current.has(p.root))
          callbacks.current.set(p.root, (value) =>
            setActivity((old) => (old[p.root] === value ? old : { ...old, [p.root]: value })),
          );
        return (
          <ProjectView
            key={p.root + (p.approvalRequired ? ":approval" : "")}
            initial={p}
            active={selected === p.root}
            onActivity={callbacks.current.get(p.root)!}
            onStatus={updateStatus}
          />
        );
      })}
    </main></SidebarProvider>
  );
}
window.escode
  .lifecycle("load")
  .then(async ({ state, restored, errors, acknowledgementRoots }) => {
    initialize(state);
    try {
      if (acknowledgementRoots?.length) {
        await persist();
        for (const root of acknowledgementRoots)
          await window.escode.project("file-operation-ack", root);
      }
    } catch (error) {
      errors.push(`Recovery acknowledgement failed; available edits retained: ${String(error)}`);
    }
    const root = import.meta.hot?.data.root ?? createRoot(document.getElementById("root")!);
    if (import.meta.hot) import.meta.hot.data.root = root;
    root.render(<App restored={restored} errors={errors} />);
  })
  .catch((error) => {
    window.escode.onClose(() => {
      void window.escode
        .lifecycle("prepare")
        .then((confirmed) => {
          if (confirmed) return window.escode.lifecycle("finish");
        })
        .catch((error) => {
          document.getElementById("root")!.textContent += "\n" + String(error);
        });
    });
    document.getElementById("root")!.textContent =
      "Workspace could not be loaded. Existing recovery data has been retained. Resolve the error and restart: " +
      String(error);
  });
