import { useLayoutEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import * as stylex from "@stylexjs/stylex";
import { workbench } from "@moonbase/ui/workbench";
import { colors, type } from "@moonbase/ui/tokens.stylex";
import { checkoutKey, fileKey, type EditorController, type EditorSnapshot } from "./editor.ts";
import type { FileTarget, FileView } from "@moonbase/application/client";

/** The composition root supplies Monaco's worker environment before mounting. */
export function MonacoView({ controller, state, target, mode }: {
  controller: EditorController; state: EditorSnapshot; target?: FileTarget; mode: FileView;
}) {
  const container = useRef<HTMLDivElement>(null);
  const models = useRef(new Map<string, { model: monaco.editor.ITextModel; listener: monaco.IDisposable }>());
  const mounted = useRef<monaco.editor.IStandaloneCodeEditor | monaco.editor.IStandaloneDiffEditor | null>(null);
  const key = target ? fileKey(target) : "", buffer = state.buffers.find(buffer => fileKey(buffer.target) === key);
  const comparison = state.comparisons[key];
  useLayoutEffect(() => {
    monaco.editor.defineTheme("moonbase", { base: "vs-dark", inherit: true, rules: [], colors: {
      "editor.background": colors.canvas, "editor.foreground": colors.text, "editorLineNumber.foreground": colors.muted,
      "editorLineNumber.activeForeground": colors.secondary, "editor.lineHighlightBackground": colors.surface,
      "editor.selectionBackground": colors.selection, "editorCursor.foreground": colors.accent,
      "editorWidget.background": colors.elevated, "editorWidget.border": colors.controlBorder,
    } });
    return () => {
      mounted.current?.dispose(); mounted.current = null;
      for (const item of models.current.values()) { item.listener.dispose(); item.model.dispose(); }
      models.current.clear();
    };
  }, [controller]);
  useLayoutEffect(() => {
    for (const buffer of state.disposed ? [] : state.buffers) {
      const key = fileKey(buffer.target);
      let entry = models.current.get(key);
      if (!entry) {
        const model = monaco.editor.createModel(buffer.text, undefined, monaco.Uri.from({ scheme: "moonbase", authority: controller.instanceId,
          path: "/" + encodeURIComponent(checkoutKey(buffer.target.checkout)) + "/" + buffer.target.path }));
        const listener = model.onDidChangeContent(() => {
          const current = controller.buffer(buffer.target), text = model.getValue();
          if (current && current.text !== text) {
            try { controller.edit(buffer.target, text); }
            catch (error) { controller.report(error); model.setValue(current.text); }
          }
        });
        entry = { model, listener }; models.current.set(key, entry);
      }
      if (entry.model.getValue() !== buffer.text) entry.model.setValue(buffer.text);
    }
    for (const [key, item] of models.current) if (state.disposed || !state.buffers.some(buffer => fileKey(buffer.target) === key)) {
      const instance = mounted.current;
      if (instance && ("getModifiedEditor" in instance ? instance.getModifiedEditor().getModel() : instance.getModel()) === item.model) {
        instance.dispose(); mounted.current = null;
      }
      item.listener.dispose(); item.model.dispose(); models.current.delete(key);
    }
  });
  useLayoutEffect(() => {
    const element = container.current;
    if (!element || !target || state.disposed || !buffer && !comparison) return;
    const working = models.current.get(key)?.model;
    const track = (editor: monaco.editor.ICodeEditor, selected: FileView | `${FileView}:original`) => {
      const position = controller.getSnapshot().recovery.views[checkoutKey(target.checkout)]?.positions[target.path]?.[selected];
      if (position) { editor.setPosition({ lineNumber: position.line, column: position.column }); editor.setScrollPosition({ scrollTop: position.top, scrollLeft: position.left }); }
      const record = () => {
        const cursor = editor.getPosition();
        if (cursor) controller.position(target, selected, { line: cursor.lineNumber, column: cursor.column, top: editor.getScrollTop(), left: editor.getScrollLeft() });
      };
      const cursor = editor.onDidChangeCursorPosition(record), scroll = editor.onDidScrollChange(record);
      return () => { record(); cursor.dispose(); scroll.dispose(); };
    };
    const options = { automaticLayout: true, theme: "moonbase", fontFamily: type.mono, fontSize: 13,
      accessibilitySupport: "on" as const, minimap: { enabled: false }, padding: { top: 16, bottom: 16 }, editContext: false,
      readOnly: !working || controller.getSnapshot().preserving, ariaLabel: target.path + " editor" };
    let release: () => void;
    if (mode !== "file" && comparison) {
      const original = monaco.editor.createModel(comparison.original, "plaintext");
      const modified = working ?? monaco.editor.createModel(comparison.working?.text ?? "", "plaintext");
      const editor = monaco.editor.createDiffEditor(element, { ...options, originalEditable: false, renderSideBySide: false });
      editor.setModel({ original, modified }); mounted.current = editor;
      editor.getOriginalEditor().updateOptions({ ariaLabel: comparison.title + " original", readOnly: true, domReadOnly: true });
      editor.getModifiedEditor().updateOptions({ ariaLabel: target.path + " editor" });
      const modifiedPosition = track(editor.getModifiedEditor(), mode), originalPosition = track(editor.getOriginalEditor(), `${mode}:original`);
      release = () => { modifiedPosition(); originalPosition(); editor.dispose(); original.dispose(); if (!working) modified.dispose(); };
    } else if (working) {
      const editor = monaco.editor.create(element, { ...options, model: working }); mounted.current = editor;
      const position = track(editor, "file"); release = () => { position(); editor.dispose(); };
    } else return;
    element.dataset.modelUri = working?.uri.toString() ?? "";
    return () => { release(); mounted.current = null; };
  }, [controller, key, mode, !!buffer, comparison?.original, comparison?.title, state.disposed]);
  useLayoutEffect(() => {
    const editor = mounted.current;
    if (editor) editor.updateOptions({ readOnly: state.preserving || !buffer });
  }, [state.preserving, !!buffer]);
  return <div ref={container} {...stylex.props(workbench.editor)} data-editor-instance={controller.instanceId} />;
}
