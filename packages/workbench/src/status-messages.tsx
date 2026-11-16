import * as stylex from '@stylexjs/stylex';
import { Button } from '@base-ui/react/button';
import { controls } from '@moonbase/ui/controls';
import type { EditorController, EditorSnapshot } from '@moonbase/application/editor';

/**
 * The editor's alerts: its latest error, a recovery publication whose outcome is unknown, and
 * file operations whose outcome needs resolving.
 */
export function StatusMessages({
  controller,
  state,
  resolvePublication,
  run,
}: {
  controller: EditorController;
  state: EditorSnapshot;
  resolvePublication: () => void;
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
      {state.publication && (
        <p role="status" {...stylex.props(controls.status)}>
          Recovery publication PENDING/UNCERTAIN ({state.publication.kind}):{' '}
          {state.publication.requestId}. Live work is retained.
          <Button {...stylex.props(controls.button)} onClick={resolvePublication}>
            Resolve recovery publication
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
