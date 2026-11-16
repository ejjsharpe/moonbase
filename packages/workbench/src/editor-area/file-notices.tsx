import * as stylex from '@stylexjs/stylex';
import { Button } from '@base-ui/react/button';
import { controls } from '@moonbase/ui/controls';
import { workbench } from '@moonbase/ui/workbench';
import { space } from '@moonbase/ui/tokens.stylex';
import type { FileTarget } from '@moonbase/contracts/workspace';
import { fileKey, type EditorController, type EditorSnapshot } from '@moonbase/application/editor';

/**
 * What stands between the active file and its editor: a save whose result is unconfirmed, a
 * change on disk that conflicts with the edits, or a file that couldn't be opened.
 */
export function FileNotices({
  controller,
  state,
  target,
  buffer,
  run,
}: {
  controller: EditorController;
  state: EditorSnapshot;
  target: FileTarget;
  buffer: EditorSnapshot['buffers'][number] | undefined;
  run: (work: Promise<unknown>) => void;
}) {
  return (
    <>
      {buffer?.pendingSave && !buffer.saving && (
        <p role="status" {...stylex.props(controls.status)}>
          Save result unconfirmed. Your edits are retained.{' '}
          <Button
            {...stylex.props(controls.button)}
            disabled={state.preserving}
            onClick={() => run(controller.save(target))}>
            Retry Save
          </Button>
        </p>
      )}
      {buffer?.conflict && (
        <div role="alert" {...stylex.props(controls.alert, workbench.conflict)}>
          <p>{target.path} changed on disk. Your edits are retained.</p>
          <div {...stylex.props(styles.toolbar)}>
            <Button
              {...stylex.props(controls.button)}
              onClick={() => run(controller.open(target, { view: 'conflict' }))}>
              Compare
            </Button>
            <Button
              {...stylex.props(controls.button)}
              onClick={() => run(controller.save(target, true))}>
              Overwrite observed version
            </Button>
            <Button
              {...stylex.props(controls.button)}
              onClick={() => run(controller.reload(target))}>
              Reload
            </Button>
            <Button
              {...stylex.props(controls.button)}
              onClick={() => controller.cancelConflict(target)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {!buffer && !state.comparisons[fileKey(target)] && (
        <p role="status" {...stylex.props(controls.alert)}>
          File unavailable; retained tab and recovery references remain.{' '}
          <Button {...stylex.props(controls.button)} onClick={() => run(controller.open(target))}>
            Retry file
          </Button>
        </p>
      )}
    </>
  );
}

const styles = stylex.create({
  toolbar: { display: 'flex', gap: space.sm, alignItems: 'center', flexWrap: 'wrap' },
});
