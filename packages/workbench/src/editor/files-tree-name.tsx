import * as stylex from '@stylexjs/stylex';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { controls } from '@moonbase/ui/controls';
import { filesUI } from '@moonbase/ui/files';
import { measureStem } from './files-tree-rows.ts';

/** How a typed name was committed: Enter keeps the field open on an error, blur never does. */
export type NameCommit = 'enter' | 'blur';

/**
 * The text field a tree row shows while its name is typed. It focuses itself with the stem
 * selected; Enter or blur commits and Escape cancels. `onCommit` resolves to an error to show
 * (or '' to keep editing without one), or null once the edit has ended.
 */
export function FilesTreeName({
  label,
  initial,
  directory,
  onCommit,
  onCancel,
}: {
  label: string;
  initial: string;
  directory: boolean;
  onCommit: (name: string, how: NameCommit) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    pending = useRef(false),
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
  async function commit(how: NameCommit) {
    if (pending.current || ended.current) return;
    pending.current = true;
    setBusy(true);
    const result = await onCommit(value, how);
    pending.current = false;
    if (result === null) {
      ended.current = true;
      return;
    }
    if (ended.current) return;
    setBusy(false);
    setError(result);
    input.current?.focus();
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
            void commit('enter');
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (pending.current || ended.current) return;
            ended.current = true;
            onCancel();
          }
        }}
        onBlur={() => void commit('blur')}
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
