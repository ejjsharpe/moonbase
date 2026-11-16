import * as stylex from '@stylexjs/stylex';
import { Button } from '@base-ui/react/button';
import { controls } from '@moonbase/ui/controls';
import type { EditorController, EditorSnapshot } from '@moonbase/application/editor';

/**
 * The editor's alerts: its latest error, recent edits not yet kept for recovery, and file
 * operations whose outcome needs resolving.
 */
export function StatusMessages({
  controller,
  state,
  retryRecovery,
  run,
}: {
  controller: EditorController;
  state: EditorSnapshot;
  retryRecovery: () => void;
  run: (work: Promise<unknown>) => void;
}) {
  return (
    <>
      {!!state.errors.length && (
        <div role="alert" {...stylex.props(controls.status, controls.alert)}>
          {state.errors.at(-1)}{' '}
          <Button {...stylex.props(controls.button)} onClick={() => controller.clearErrors()}>
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
            onClick={() => run(controller.resolveOperation(operation.id, operation.clientId))}>
            Resolve operation status
          </Button>
        </p>
      ))}
    </>
  );
}
