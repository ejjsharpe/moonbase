import type { ClipboardEvent, KeyboardEvent, ReactNode, Ref } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@base-ui/react/button';
import { controls } from '@moonbase/ui/controls';
import { workbench } from '@moonbase/ui/workbench';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import type { EditorController } from '@moonbase/application/editor';
import { isCommandKey } from '../shortcuts.ts';
import { listExplorerActions, type ExplorerActionContext } from './explorer-actions.ts';
import { ExplorerMenu } from './explorer-menu.tsx';
import { WorktreeSwitcher } from './worktree-switcher.tsx';

/** The explorer's two views of a checkout: its files, and a Git checkout's changes. */
export type ExplorerPanel = 'files' | 'git';

/**
 * The explorer: the checkout's worktree switcher and "…" menu over its view, `children`, with the
 * Files/Changes switch for a Git checkout. ⌘V in it, or a paste, goes to `onPaste`.
 */
export function Explorer({
  ref,
  actionsButtonRef,
  controller,
  checkout,
  actions,
  git,
  panel,
  onPanel,
  changedFiles,
  onPaste,
  run,
  children,
}: {
  ref?: Ref<HTMLDivElement>;
  /** The "…" button, where focus lands when the editor has nothing better. */
  actionsButtonRef?: Ref<HTMLButtonElement>;
  controller: EditorController;
  checkout: CheckoutTarget;
  /** What the "…" menu's actions act on and through. */
  actions: ExplorerActionContext;
  git: boolean;
  panel: ExplorerPanel;
  onPanel: (panel: ExplorerPanel) => void;
  /** How many files have changes, each counted once. */
  changedFiles: number;
  onPaste: (event: ClipboardEvent | KeyboardEvent) => void;
  run: (work: Promise<unknown>) => void;
  children: ReactNode;
}) {
  return (
    <div
      ref={ref}
      {...stylex.props(styles.panel)}
      onPaste={onPaste}
      onKeyDown={(event) => {
        if (isCommandKey(event, 'v')) onPaste(event);
      }}>
      <div {...stylex.props(workbench.pane, workbench.explorerPane)}>
        <div {...stylex.props(workbench.explorerHeader)}>
          <WorktreeSwitcher controller={controller} checkout={checkout} run={run} />
          <ExplorerMenu actions={listExplorerActions(actions)} triggerRef={actionsButtonRef} />
        </div>
        {git && (
          <div {...stylex.props(workbench.viewNav)}>
            <div role="group" aria-label="Sidebar view" {...stylex.props(workbench.viewSwitch)}>
              <Button
                title="Files · ⇧⌘E"
                {...stylex.props(
                  controls.button,
                  workbench.viewButton,
                  panel === 'files' && workbench.activeView,
                )}
                aria-pressed={panel === 'files'}
                onClick={() => onPanel('files')}>
                Files
              </Button>
              <Button
                title={`${changedFiles} changed · ⇧⌘G`}
                {...stylex.props(
                  controls.button,
                  workbench.viewButton,
                  panel === 'git' && workbench.activeView,
                )}
                aria-pressed={panel === 'git'}
                onClick={() => onPanel('git')}>
                Changes
                {changedFiles > 0 && (
                  <span aria-hidden="true" {...stylex.props(workbench.changeCount)}>
                    {changedFiles}
                  </span>
                )}
              </Button>
            </div>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

const styles = stylex.create({
  panel: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
});
