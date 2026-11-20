import * as stylex from '@stylexjs/stylex';
import { Button } from '@base-ui/react/button';
import { controls } from '@moonbase/ui/controls';
import type { EditorSnapshot } from '@moonbase/application/editor';
import type { EditorActions } from './editor-actions.ts';
import { useEditorTask } from './use-editor-task.ts';

/**
 * The editor's alerts: its latest error, recent edits not yet kept for recovery, and file
 * operations whose outcome needs resolving.
 */
export function StatusMessages({
  actions,
  state,
  retryRecovery,
}: {
  actions: EditorActions;
  state: EditorSnapshot;
  retryRecovery: () => void;
}) {
  const run = useEditorTask(actions);
  return (
    <>
      {!!state.errors.length && (
        <div role="alert" {...stylex.props(controls.status, controls.alert)}>
          {state.errors.at(-1)}{' '}
          <Button {...stylex.props(controls.button)} onClick={() => actions.clearErrors()}>
            Dismiss error
          </Button>
        </div>
      )}
      {state.recoveryFailed && (
        <p role="status" {...stylex.props(controls.status)}>
          Recent edits are not yet kept for recovery. They stay open here.
          <Button {...stylex.props(controls.button)} onClick={retryRecovery}>
            Retry keeping edits
          </Button>
        </p>
      )}
      {state.operations.map((operation) => (
        <p
          key={JSON.stringify([operation.clientId, operation.id])}
          role="status"
          {...stylex.props(controls.status)}>
          {operation.kind}: {operation.outcome}. {operation.message}
          <Button
            {...stylex.props(controls.button)}
            onClick={() => run(actions.resolveOperation(operation.id, operation.clientId))}>
            Resolve operation status
          </Button>
        </p>
      ))}
    </>
  );
}
