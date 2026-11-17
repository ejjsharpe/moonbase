import * as stylex from '@stylexjs/stylex';
import { Button } from '@base-ui/react/button';
import { controls } from '@moonbase/ui/controls';
import { gitStatusHues, gitStatusUI } from '@moonbase/ui/files';
import { workbench } from '@moonbase/ui/workbench';
import type { CheckoutTarget, FileTarget, FileView } from '@moonbase/contracts/workspace';
import { checkoutKey, type EditorSnapshot } from '@moonbase/application/editor';
import { gitStatusMarks } from '../files-tree/files-tree-status.ts';
import type { EditorActions } from '../editor-actions.ts';

// A conflicted path opens as its file, where its conflict markers are resolved; one both sides
// deleted has no file to open, and is resolved in Git.
const changeAreas = [
  { area: 'conflicted', label: 'Conflicts', view: 'file' },
  { area: 'staged', label: 'Staged', view: 'staged' },
  { area: 'unstaged', label: 'Changes', view: 'unstaged' },
  { area: 'untracked', label: 'Untracked', view: 'untracked' },
] as const;

/**
 * The explorer's Changes view: a Git checkout's changed files by area, each opening its
 * comparison, with the shown one marked.
 */
export function ChangesView({
  actions,
  state,
  checkout,
  target,
  mode,
  run,
}: {
  actions: EditorActions;
  state: EditorSnapshot;
  checkout: CheckoutTarget;
  /** The active file, and the view it shows in. */
  target: FileTarget | undefined;
  mode: FileView;
  run: (work: Promise<unknown>) => void;
}) {
  const git = state.git[checkoutKey(checkout)],
    changes = git?.changes ?? [];
  return (
    <>
      {git?.error && (
        <p role="status" {...stylex.props(controls.alert)}>
          {git.error}
        </p>
      )}
      {git && !changes.length && (
        <p role="status" {...stylex.props(workbench.noChanges)}>
          No changes
        </p>
      )}
      {changeAreas.map(({ area, label, view }) => {
        const listed = changes.filter((change) => change.area === area);
        if (!listed.length) return null;
        return (
          <section key={area} aria-label={label}>
            <h2 {...stylex.props(workbench.changeHeading)}>
              {label}
              <span {...stylex.props(workbench.changeHeadingCount)}>{listed.length}</span>
            </h2>
            <ul {...stylex.props(controls.list)}>
              {listed.map((change) => {
                const active = target?.path === change.path && mode === view;
                const mark = gitStatusMarks[change.kind];
                const description = change.missing
                  ? mark.label + ', deleted on both sides'
                  : mark.label;
                const folder = change.path.slice(0, change.path.lastIndexOf('/') + 1);
                return (
                  <li key={change.path}>
                    <Button
                      aria-label={change.path}
                      aria-description={description}
                      aria-current={active || undefined}
                      disabled={change.missing}
                      title={
                        change.missing ? `${change.path} (deleted on both sides)` : change.path
                      }
                      {...stylex.props(
                        controls.button,
                        controls.listButton,
                        workbench.changeRow,
                        active && workbench.activeChange,
                      )}
                      onClick={() =>
                        run(
                          actions.open(
                            { checkout, path: change.path },
                            { view, intent: 'preview' },
                          ),
                        )
                      }>
                      <span {...stylex.props(workbench.changeName, gitStatusHues[change.kind])}>
                        {change.path.slice(folder.length)}
                      </span>
                      {folder && <span {...stylex.props(workbench.changeFolder)}>{folder}</span>}
                      <span aria-hidden="true" {...stylex.props(gitStatusUI.slot)}>
                        <span
                          data-git-status={change.kind}
                          {...stylex.props(gitStatusUI.letter, gitStatusHues[change.kind])}>
                          {mark.letter}
                        </span>
                      </span>
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </>
  );
}
