import { useLayoutEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import { Effect } from 'effect';
import { checkoutKey, type EditorBuffer } from '@moonbase/application/editor';
import type { EditorActions } from './editor-actions.ts';

/** A buffer's Monaco model, with the buffer it last showed. */
type BufferModel = {
  model: monaco.editor.ITextModel;
  listener: monaco.IDisposable;
  shown: EditorBuffer;
};

/**
 * Monaco's models of the editor's buffers, one per file by its key, kept in step with the buffers
 * outside render: a change to one buffer touches only its model, and typing in a model sends its
 * text as an edit. `release` runs before a model is disposed, so a view showing it lets it go
 * first. The models live as long as the calling view, or until its editor's actions change.
 */
export function useMonacoModels(
  actions: EditorActions,
  release: (model: monaco.editor.ITextModel) => void,
) {
  const models = useRef(new Map<string, BufferModel>());
  const releasing = useRef(release);
  useLayoutEffect(() => {
    releasing.current = release;
  });
  useLayoutEffect(() => {
    const owned = models.current,
      { atoms } = actions;
    const dispose = (key: string, entry: BufferModel) => {
      releasing.current(entry.model);
      entry.listener.dispose();
      entry.model.dispose();
      owned.delete(key);
    };
    const create = (buffer: EditorBuffer): BufferModel => {
      const model = monaco.editor.createModel(
        buffer.text,
        undefined,
        monaco.Uri.from({
          scheme: 'moonbase',
          authority: actions.clientId,
          path:
            '/' +
            encodeURIComponent(checkoutKey(buffer.target.checkout)) +
            '/' +
            buffer.target.path,
        }),
      );
      const listener = model.onDidChangeContent(() => {
        const current = actions.buffer(buffer.target),
          text = model.getValue(undefined, true);
        if (current && current.text !== text)
          actions.start(
            actions.edit(buffer.target, text).pipe(
              Effect.tapError(() =>
                Effect.sync(() => {
                  // The refused text goes; the buffer's stays.
                  const kept = actions.buffer(buffer.target);
                  if (kept && model.getValue(undefined, true) !== kept.text)
                    model.setValue(kept.text);
                }),
              ),
            ),
          );
      });
      return { model, listener, shown: buffer };
    };
    const sync = () => {
      const buffers = actions.read(atoms.session.disposed)
        ? new Map<string, EditorBuffer>()
        : actions.read(atoms.buffers.state).buffers;
      for (const [key, buffer] of buffers) {
        let entry = owned.get(key);
        // An update keeps every buffer it didn't change, so only a changed one is read.
        if (entry?.shown === buffer) continue;
        if (!entry) {
          entry = create(buffer);
          owned.set(key, entry);
        }
        entry.shown = buffer;
        if (entry.model.getValue(undefined, true) !== buffer.text)
          entry.model.setValue(buffer.text);
      }
      for (const [key, entry] of owned) if (!buffers.has(key)) dispose(key, entry);
    };
    sync();
    const stops = [
      actions.subscribe(atoms.buffers.state, sync),
      actions.subscribe(atoms.session.disposed, sync),
    ];
    return () => {
      for (const stop of stops) stop();
      for (const [key, entry] of owned) dispose(key, entry);
    };
  }, [actions]);
  return models;
}
