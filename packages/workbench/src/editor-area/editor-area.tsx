import type { Ref } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Tabs } from '@base-ui/react/tabs';
import { workbench } from '@moonbase/ui/workbench';
import type { CheckoutTarget, FileTarget, FileView } from '@moonbase/contracts/workspace';
import type { EditorSnapshot } from '@moonbase/application/editor';
import { CheatSheet, editorShortcuts } from '../cheat-sheet.tsx';
import { EditorTabs, type EditorTabsHandle } from '../editor-tabs/editor-tabs.tsx';
import type { FocusReturn } from '../focus-return.ts';
import { MonacoView, type EditorReveal, type MonacoViewHandle } from '../monaco-view.tsx';
import type { Shortcut } from '../shortcuts.ts';
import { Breadcrumbs } from './breadcrumbs.tsx';
import { FileNotices } from './file-notices.tsx';
import type { EditorActions } from '../editor-actions.ts';

/**
 * The main editor: a checkout's open files as tabs over the active file's breadcrumbs, notices
 * and Monaco view, or the shortcut list when no file is open.
 */
export function EditorArea({
  actions,
  state,
  checkout,
  view,
  target,
  buffer,
  mode,
  git,
  visible,
  showBreadcrumbs,
  shortcuts,
  reveal,
  onRevealed,
  tabsRef,
  monacoRef,
  run,
  closeFiles,
  withFocus,
}: {
  actions: EditorActions;
  state: EditorSnapshot;
  checkout: CheckoutTarget;
  view: EditorSnapshot['recovery']['views'][string];
  target: FileTarget | undefined;
  buffer: EditorSnapshot['buffers'][number] | undefined;
  mode: FileView;
  git: boolean;
  visible: boolean;
  showBreadcrumbs: boolean;
  shortcuts: readonly Shortcut[];
  reveal: EditorReveal | undefined;
  onRevealed: () => void;
  tabsRef: Ref<EditorTabsHandle>;
  monacoRef: Ref<MonacoViewHandle>;
  run: (work: Promise<unknown>) => void;
  closeFiles: (paths: string[]) => Promise<boolean>;
  withFocus: FocusReturn['withFocus'];
}) {
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
          state={state}
          checkout={checkout}
          view={view}
          git={git}
          run={run}
          closeFiles={closeFiles}
          withFocus={withFocus}
        />
        <div {...stylex.props(workbench.pane, workbench.canvasPane)}>
          {showBreadcrumbs && target && (
            <Breadcrumbs
              checkout={checkout}
              path={target.path}
              unsaved={!!buffer && buffer.text !== buffer.disk.text}
            />
          )}
          {target ? (
            <FileNotices
              actions={actions}
              state={state}
              target={target}
              buffer={buffer}
              run={run}
            />
          ) : (
            <CheatSheet shortcuts={[...editorShortcuts, ...shortcuts]} />
          )}
          <MonacoView
            ref={monacoRef}
            actions={actions}
            state={state}
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
