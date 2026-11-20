import * as stylex from '@stylexjs/stylex';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { controls } from '@moonbase/ui/controls';
import { filesUI } from '@moonbase/ui/files';
import { Effect } from 'effect';
import { measureStem } from './files-tree-rows.ts';
import type { EditorActions } from '../editor-actions.ts';
import { usePendingEditorTask } from '../use-editor-task.ts';
import type { WorkbenchServices } from '../workbench-editor.ts';

/** How a typed name was committed: Enter keeps the field open on an error, blur never does. */
export type NameCommit = 'enter' | 'blur';

/**
 * The text field a tree row shows while its name is typed. It focuses itself with the stem
 * selected; Enter or blur commits and Escape cancels. Focus leaving the window is no blur: the
 * field keeps editing and takes focus back when the window does. `onCommit` succeeds with an error
 * to show (or '' to keep editing without one), or null once the edit has ended; a blur passes
 * where focus went.
 */
export function FilesTreeName({
  actions,
  label,
  initial,
  directory,
  onCommit,
  onCancel,
}: {
  actions: EditorActions;
  label: string;
  initial: string;
  directory: boolean;
  onCommit: (
    name: string,
    how: NameCommit,
    next: Element | null,
  ) => Effect.Effect<string | null, unknown, WorkbenchServices>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial),
    [error, setError] = useState('');
  // One commit at a time, while the field shows.
  const [busy, run] = usePendingEditorTask(actions);
  const input = useRef<HTMLInputElement>(null),
    ended = useRef(false),
    errorId = useId();
  useLayoutEffect(() => {
    ended.current = false;
    const element = input.current!;
    element.focus();
    element.setSelectionRange(0, measureStem(initial, directory));
    return () => {
      ended.current = true;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Select the stem once, as the field opens.
  }, []);
  useEffect(() => {
    const element = input.current!,
      view = element.ownerDocument.defaultView!;
    function regainFocus() {
      const focused = element.ownerDocument.activeElement;
      if (!ended.current && (!focused || focused === element.ownerDocument.body)) element.focus();
    }
    view.addEventListener('focus', regainFocus);
    return () => view.removeEventListener('focus', regainFocus);
  }, []);
  function commit(how: NameCommit, next: Element | null = null) {
    if (ended.current) return;
    run(
      Effect.tap(onCommit(value, how, next), (result) =>
        Effect.sync(() => {
          if (result === null) {
            ended.current = true;
            return;
          }
          if (ended.current) return;
          setError(result);
          // Take focus back from a closing prompt or from nowhere, but not from where the user
          // went.
          const element = input.current,
            focused = element?.ownerDocument.activeElement;
          if (
            element &&
            (!focused ||
              focused === element ||
              focused === element.ownerDocument.body ||
              focused.closest('[role="dialog"]'))
          )
            element.focus();
        }),
      ),
    );
  }
  return (
    <span {...stylex.props(filesUI.edit)}>
      <input
        ref={input}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        aria-busy={busy || undefined}
        readOnly={busy}
        spellCheck={false}
        autoComplete="off"
        value={value}
        {...stylex.props(controls.field, filesUI.nameField, !!error && filesUI.invalidField)}
        onChange={(event) => {
          setValue(event.target.value);
          setError('');
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            commit('enter');
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (busy || ended.current) return;
            ended.current = true;
            onCancel();
          }
        }}
        onBlur={(event) => {
          // The window losing focus, such as on ⌘Tab, leaves the name being typed.
          if (!event.currentTarget.ownerDocument.hasFocus()) return;
          commit('blur', event.relatedTarget);
        }}
        // The row's own pointer gestures select, open and toggle; the field keeps its own.
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
      />
      {error && (
        <span id={errorId} role="alert" {...stylex.props(filesUI.editError)}>
          {error}
        </span>
      )}
    </span>
  );
}
