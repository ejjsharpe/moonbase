import type { Ref } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Tabs } from '@base-ui/react/tabs';
import { workbench } from '@moonbase/ui/workbench';
import type { CheckoutTarget, FileTarget, FileView } from '@moonbase/contracts/workspace';
import { useAtomValue } from '@effect/atom-react';
import { fileKey, type CheckoutTabs } from '@moonbase/application/editor';
import { CheatSheet, editorShortcuts } from '../cheat-sheet.tsx';
import { EditorTabs, type EditorTabsHandle } from '../editor-tabs/editor-tabs.tsx';
import type { FocusReturn } from '../focus-return.ts';
import { MonacoView, type EditorReveal, type MonacoViewHandle } from '../monaco-view.tsx';
import type { Shortcut } from '../shortcuts.ts';
import { Breadcrumbs } from './breadcrumbs.tsx';
import { FileNotices } from './file-notices.tsx';
import type { EditorActions } from '../editor-actions.ts';
import { useEditorTask } from '../use-editor-task.ts';
import type { Effect } from 'effect';
import type { WorkbenchServices } from '../workbench-editor.ts';

/**
 * The main editor: a checkout's open files as tabs over the active file's breadcrumbs, notices
 * and Monaco view, or the shortcut list when no file is open.
 */
export function EditorArea({
  actions,
  checkout,
  view,
  target,
  mode,
  git,
  visible,
  showBreadcrumbs,
  shortcuts,
  reveal,
  onRevealed,
  tabsRef,
  monacoRef,
  closeFiles,
  withFocus,
}: {
  actions: EditorActions;
  checkout: CheckoutTarget;
  view: CheckoutTabs;
  target: FileTarget | undefined;
  mode: FileView;
  git: boolean;
  visible: boolean;
  showBreadcrumbs: boolean;
  shortcuts: readonly Shortcut[];
  reveal: EditorReveal | undefined;
  onRevealed: () => void;
  tabsRef: Ref<EditorTabsHandle>;
  monacoRef: Ref<MonacoViewHandle>;
  closeFiles: (paths: string[]) => Effect.Effect<boolean, unknown, WorkbenchServices>;
  withFocus: FocusReturn['withFocus'];
}) {
  const run = useEditorTask(actions);
  // How the active file's buffer stands, which changes with its status, not as one types.
  const buffer = useAtomValue(actions.atoms.buffers.status(target ? fileKey(target) : ''));
  return (
    <section
      data-title-anchor=""
      {...stylex.props(workbench.content, styles.panel)}
      aria-label="Main editor">
      <Tabs.Root
        value={view.active}
        onValueChange={(value) => run(actions.open({ checkout, path: String(value) }))}
        {...stylex.props(styles.panel)}>
        <EditorTabs
          ref={tabsRef}
          actions={actions}
          checkout={checkout}
          view={view}
          git={git}
          closeFiles={closeFiles}
          withFocus={withFocus}
        />
        <div {...stylex.props(workbench.pane, workbench.canvasPane)}>
          {showBreadcrumbs && target && (
            <Breadcrumbs checkout={checkout} path={target.path} unsaved={!!buffer?.dirty} />
          )}
          {target ? (
            <FileNotices actions={actions} target={target} buffer={buffer} />
          ) : (
            <CheatSheet shortcuts={[...editorShortcuts, ...shortcuts]} />
          )}
          <MonacoView
            ref={monacoRef}
            actions={actions}
            target={target}
            mode={mode}
            visible={visible}
            reveal={reveal}
            onRevealed={onRevealed}
          />
        </div>
      </Tabs.Root>
    </section>
  );
}

const styles = stylex.create({
  panel: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
});
