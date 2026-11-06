import { useLayoutEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import * as stylex from '@stylexjs/stylex';
import { workbench } from '@moonbase/ui/workbench';
import { colors, syntax, type } from '@moonbase/ui/tokens.stylex';
import {
  checkoutKey,
  fileKey,
  readOwn,
  type EditorController,
  type EditorSnapshot,
} from '@moonbase/application/editor';
import type { FileTarget, FileView } from '@moonbase/contracts/workspace';

/** The composition root supplies Monaco's worker environment before mounting. */
export function MonacoView({
  controller,
  state,
  target,
  mode,
  visible,
}: {
  controller: EditorController;
  state: EditorSnapshot;
  target?: FileTarget;
  mode: FileView;
  visible: boolean;
}) {
  const container = useRef<HTMLDivElement>(null),
    visibility = useRef(visible);
  useLayoutEffect(() => {
    visibility.current = visible;
  }, [visible]);
  const models = useRef(
    new Map<string, { model: monaco.editor.ITextModel; listener: monaco.IDisposable }>(),
  );
  const mounted = useRef<
    monaco.editor.IStandaloneCodeEditor | monaco.editor.IStandaloneDiffEditor | null
  >(null);
  const releaseView = useRef<(() => void) | null>(null);
  const key = target ? fileKey(target) : '',
    buffer = state.buffers.find((buffer) => fileKey(buffer.target) === key);
  const comparison = state.comparisons[key];
  const hasBuffer = !!buffer;
  useLayoutEffect(() => {
    monaco.editor.defineTheme('moonbase', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: syntax.comment.slice(1), fontStyle: 'italic' },
        { token: 'keyword', foreground: syntax.keyword.slice(1) },
        { token: 'string', foreground: syntax.string.slice(1) },
        { token: 'number', foreground: syntax.number.slice(1) },
        { token: 'regexp', foreground: syntax.regexp.slice(1) },
        { token: 'type', foreground: syntax.type.slice(1) },
        { token: 'identifier', foreground: syntax.variable.slice(1) },
        { token: 'delimiter', foreground: syntax.operator.slice(1) },
        { token: 'operator', foreground: syntax.operator.slice(1) },
      ],
      colors: {
        'editor.background': colors.canvas,
        'editor.foreground': colors.text,
        'editorLineNumber.foreground': colors.muted,
        'editorLineNumber.activeForeground': colors.secondary,
        'editor.lineHighlightBackground': colors.surface,
        'editor.selectionBackground': colors.selection,
        'editorCursor.foreground': colors.accent,
        'editorWidget.background': colors.elevated,
        'editorWidget.border': colors.controlBorder,
        'scrollbar.shadow': colors.scrollShadow,
      },
    });
    // Monaco measures glyphs once; measure again after the bundled font finishes loading.
    void document.fonts.ready.then(() => monaco.editor.remeasureFonts());
    const ownedModels = models.current;
    return () => {
      releaseView.current?.();
      releaseView.current = null;
      for (const item of ownedModels.values()) {
        item.listener.dispose();
        item.model.dispose();
      }
      ownedModels.clear();
    };
  }, [controller]);
  useLayoutEffect(() => {
    for (const buffer of state.disposed ? [] : state.buffers) {
      const key = fileKey(buffer.target);
      let entry = models.current.get(key);
      if (!entry) {
        const model = monaco.editor.createModel(
          buffer.text,
          undefined,
          monaco.Uri.from({
            scheme: 'moonbase',
            authority: controller.instanceId,
            path:
              '/' +
              encodeURIComponent(checkoutKey(buffer.target.checkout)) +
              '/' +
              buffer.target.path,
          }),
        );
        const listener = model.onDidChangeContent(() => {
          const current = controller.buffer(buffer.target),
            text = model.getValue(undefined, true);
          if (current && current.text !== text) {
            try {
              controller.edit(buffer.target, text);
            } catch (error) {
              controller.report(error);
              model.setValue(current.text);
            }
          }
        });
        entry = { model, listener };
        models.current.set(key, entry);
      }
      if (entry.model.getValue(undefined, true) !== buffer.text) entry.model.setValue(buffer.text);
    }
    for (const [key, item] of models.current)
      if (state.disposed || !state.buffers.some((buffer) => fileKey(buffer.target) === key)) {
        const instance = mounted.current;
        if (
          instance &&
          ('getModifiedEditor' in instance
            ? instance.getModifiedEditor().getModel()
            : instance.getModel()) === item.model
        ) {
          releaseView.current?.();
          releaseView.current = null;
        }
        item.listener.dispose();
        item.model.dispose();
        models.current.delete(key);
      }
  });
  useLayoutEffect(() => {
    const element = container.current;
    if (!element || !target || state.disposed || (!buffer && !comparison)) return;
    const working = models.current.get(key)?.model;
    const track = (
      editor: monaco.editor.ICodeEditor,
      selected: FileView | `${FileView}:original`,
    ) => {
      const position = readOwn(
        readOwn(
          readOwn(controller.getSnapshot().recovery.views, target.checkout.checkoutId)?.positions,
          target.path,
        ),
        selected,
      );
      if (position) {
        editor.setPosition({ lineNumber: position.line, column: position.column });
        editor.setScrollPosition({ scrollTop: position.top, scrollLeft: position.left });
      }
      const record = () => {
        // Hidden layout changes are presentation artifacts, not user view positions.
        if (!visibility.current) return;
        try {
          const cursor = editor.getPosition();
          if (cursor)
            controller.position(target, selected, {
              line: cursor.lineNumber,
              column: cursor.column,
              top: editor.getScrollTop(),
              left: editor.getScrollLeft(),
            });
        } catch (error) {
          controller.report(error);
        }
      };
      const cursor = editor.onDidChangeCursorPosition(record),
        scroll = editor.onDidScrollChange(record);
      return () => {
        record();
        cursor.dispose();
        scroll.dispose();
      };
    };
    const options = {
      automaticLayout: true,
      theme: 'moonbase',
      fontFamily: type.mono,
      fontSize: 13,
      accessibilitySupport: 'on' as const,
      minimap: { enabled: false },
      padding: { top: 16, bottom: 16 },
      editContext: false,
      readOnly: !working || controller.getSnapshot().preserving,
      ariaLabel: target.path + ' editor',
    };
    let release: () => void;
    if (mode !== 'file' && comparison) {
      const original = monaco.editor.createModel(comparison.original, 'plaintext');
      const modified =
        working ?? monaco.editor.createModel(comparison.working?.text ?? '', 'plaintext');
      const editor = monaco.editor.createDiffEditor(element, {
        ...options,
        originalEditable: false,
        renderSideBySide: false,
        originalAriaLabel: comparison.title + ' original',
        modifiedAriaLabel: target.path + ' editor',
      });
      const viewModel = editor.createViewModel({ original, modified });
      editor.setModel(viewModel);
      mounted.current = editor;
      editor.getOriginalEditor().updateOptions({
        ariaLabel: comparison.title + ' original',
        readOnly: true,
        domReadOnly: true,
      });
      editor.getModifiedEditor().updateOptions({ ariaLabel: target.path + ' editor' });
      const modifiedPosition = track(editor.getModifiedEditor(), mode),
        originalPosition = track(editor.getOriginalEditor(), `${mode}:original`);
      release = () => {
        modifiedPosition();
        originalPosition();
        editor.setModel(null);
        editor.dispose();
        viewModel.dispose();
        original.dispose();
        if (!working) modified.dispose();
      };
    } else if (working) {
      const editor = monaco.editor.create(element, { ...options, model: working });
      mounted.current = editor;
      const position = track(editor, 'file');
      release = () => {
        position();
        editor.dispose();
      };
    } else return;
    element.dataset.modelUri = working?.uri.toString() ?? '';
    let released = false;
    const cleanup = () => {
      if (!released) {
        released = true;
        release();
        mounted.current = null;
      }
    };
    releaseView.current = cleanup;
    return cleanup;
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Recreate the view only for identity/mode/baseline changes; buffer edits sync through the existing model above.
  }, [controller, key, mode, hasBuffer, comparison?.original, comparison?.title, state.disposed]);
  useLayoutEffect(() => {
    const editor = mounted.current;
    if (!editor || !target) return;
    const positions = readOwn(
      readOwn(controller.getSnapshot().recovery.views, target.checkout.checkoutId)?.positions,
      target.path,
    );
    const modified = readOwn(positions, mode),
      original = readOwn(positions, `${mode}:original`);
    editor.updateOptions({ automaticLayout: visible });
    if (!visible) return;
    editor.layout();
    const restoreScroll = (view: monaco.editor.ICodeEditor, position: typeof modified) => {
      if (!position) return;
      view.setScrollPosition({ scrollTop: position.top, scrollLeft: position.left });
    };
    if ('getModifiedEditor' in editor) {
      restoreScroll(editor.getOriginalEditor(), original);
      restoreScroll(editor.getModifiedEditor(), modified);
    } else restoreScroll(editor, modified);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Restore visibility on the same view identities as creation; typing must not relayout the editor.
  }, [
    visible,
    controller,
    key,
    mode,
    hasBuffer,
    comparison?.original,
    comparison?.title,
    state.disposed,
  ]);
  useLayoutEffect(() => {
    const editor = mounted.current;
    if (editor) {
      const readOnly = state.preserving || !hasBuffer;
      if ('getModifiedEditor' in editor) {
        const diffOptions: monaco.editor.IDiffEditorConstructionOptions = {
          readOnly,
          originalAriaLabel: comparison?.title + ' original',
          modifiedAriaLabel: target?.path + ' editor',
        };
        editor.updateOptions(diffOptions);
      } else editor.updateOptions({ readOnly });
    }
  }, [visible, state.preserving, hasBuffer, comparison?.title, target?.path]);
  return (
    <div
      ref={container}
      {...stylex.props(workbench.editor)}
      data-editor-instance={controller.instanceId}
    />
  );
}
