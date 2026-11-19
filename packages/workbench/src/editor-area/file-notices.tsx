import * as stylex from '@stylexjs/stylex';
import { Button } from '@base-ui/react/button';
import { controls } from '@moonbase/ui/controls';
import { workbench } from '@moonbase/ui/workbench';
import { space } from '@moonbase/ui/tokens.stylex';
import type { FileTarget } from '@moonbase/contracts/workspace';
import { fileKey, type EditorSnapshot } from '@moonbase/application/editor';
import type { EditorActions } from '../editor-actions.ts';
import { useEditorTask } from '../use-editor-task.ts';

/**
 * What stands between the active file and its editor: a save whose result is unconfirmed, a
 * change on disk that conflicts with the edits, or a file that couldn't be opened.
 */
export function FileNotices({
  actions,
  state,
  target,
  buffer,
}: {
  actions: EditorActions;
  state: EditorSnapshot;
  target: FileTarget;
  buffer: EditorSnapshot['buffers'][number] | undefined;
}) {
  const run = useEditorTask(actions);
  return (
    <>
      {buffer?.pendingSave && !buffer.saving && (
        <p role="status" {...stylex.props(controls.status)}>
          Save result unconfirmed. Your edits are retained.{' '}
          <Button
            {...stylex.props(controls.button)}
            disabled={state.preserving}
            onClick={() => run(actions.save(target))}>
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
              onClick={() => run(actions.open(target, { view: 'conflict' }))}>
              Compare
            </Button>
            <Button
              {...stylex.props(controls.button)}
              onClick={() => run(actions.save(target, true))}>
              Overwrite observed version
            </Button>
            <Button {...stylex.props(controls.button)} onClick={() => run(actions.reload(target))}>
              Reload
            </Button>
            <Button
              {...stylex.props(controls.button)}
              onClick={() => actions.cancelConflict(target)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {!buffer && !state.comparisons[fileKey(target)] && (
        <p role="status" {...stylex.props(controls.alert)}>
          File unavailable; retained tab and recovery references remain.{' '}
          <Button {...stylex.props(controls.button)} onClick={() => run(actions.open(target))}>
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
