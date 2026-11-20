import * as stylex from '@stylexjs/stylex';
import { Button } from '@base-ui/react/button';
import { controls } from '@moonbase/ui/controls';
import { workbench } from '@moonbase/ui/workbench';
import { space } from '@moonbase/ui/tokens.stylex';
import type { FileTarget } from '@moonbase/contracts/workspace';
import { useAtomValue } from '@effect/atom-react';
import { fileKey, type BufferStatus } from '@moonbase/application/editor';
import type { EditorActions } from '../editor-actions.ts';
import { useEditorTask } from '../use-editor-task.ts';

/**
 * What stands between the active file and its editor: a save whose result is unconfirmed, a
 * change on disk that conflicts with the edits, or a file that couldn't be opened.
 */
export function FileNotices({
  actions,
  target,
  buffer,
}: {
  actions: EditorActions;
  target: FileTarget;
  /** How the file's buffer stands, or undefined while it has none. */
  buffer: BufferStatus | undefined;
}) {
  const run = useEditorTask(actions);
  const preserving = useAtomValue(actions.atoms.session.preserving),
    comparison = useAtomValue(actions.atoms.discovery.comparison(fileKey(target)));
  return (
    <>
      {buffer?.pendingSave && !buffer.saving && (
        <p role="status" {...stylex.props(controls.status)}>
          Save result unconfirmed. Your edits are retained.{' '}
          <Button
            {...stylex.props(controls.button)}
            disabled={preserving}
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
      {!buffer && !comparison && (
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
