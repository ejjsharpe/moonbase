import type { RefObject } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ContextMenu as Menu } from '@base-ui/react/context-menu';
import { overlays } from '@moonbase/ui/overlays';
import { workbench } from '@moonbase/ui/workbench';
import { Icon } from '@moonbase/ui/icons';
import type { FileTarget, FileView } from '@moonbase/contracts/workspace';
import type { BufferStatus } from '@moonbase/application/editor';
import type { FocusReturn } from '../focus-return.ts';
import type { EditorActions } from '../editor-actions.ts';
import { useEditorTask } from '../use-editor-task.ts';
import type { Effect } from 'effect';
import type { WorkbenchServices } from '../workbench-editor.ts';

const closeLabels = ['Close', 'Close Others', 'Close to the Right', 'Close All'] as const;

/**
 * A tab's right-click menu: Keep Open, the Close commands, moving the tab, Save, its file view and
 * Reopen. The Close commands act on the tabs open when the menu opened, `captured`, and return
 * focus to the tab strip.
 */
export function EditorTabMenu({
  actions,
  preserving,
  file,
  buffer: current,
  openFiles,
  captured,
  fileView,
  git,
  openedByKeyboard,
  closeFiles,
  withFocus,
}: {
  actions: EditorActions;
  preserving: boolean;
  file: FileTarget;
  buffer: BufferStatus | undefined;
  /** The checkout's open tabs, in order. */
  openFiles: readonly string[];
  captured: RefObject<string[]>;
  fileView: FileView;
  /** Whether the checkout has Git's comparisons. */
  git: boolean;
  /** Whether the menu was just opened from the keyboard, so its first item takes focus; asking clears it. */
  openedByKeyboard: () => boolean;
  closeFiles: (paths: string[]) => Effect.Effect<boolean, unknown, WorkbenchServices>;
  withFocus: FocusReturn['withFocus'];
}) {
  const run = useEditorTask(actions);
  const { checkout, path } = file;
  function closeFor(label: (typeof closeLabels)[number]) {
    const paths = captured.current;
    if (label === 'Close') return [path];
    if (label === 'Close Others') return paths.filter((other) => other !== path);
    if (label === 'Close to the Right') return paths.slice(paths.indexOf(path) + 1);
    return paths;
  }
  return (
    <Menu.Portal>
      <Menu.Positioner {...stylex.props(overlays.positioner)}>
        <Menu.Popup
          onFocus={(event) => {
            if (openedByKeyboard())
              event.currentTarget.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
          }}
          {...stylex.props(overlays.popup, overlays.options)}>
          <Menu.Item {...stylex.props(overlays.option)} onClick={() => actions.keepOpen(file)}>
            Keep Open
          </Menu.Item>
          {closeLabels.map((label) => (
            <Menu.Item
              key={label}
              {...stylex.props(overlays.option)}
              // The editor's own work, which outlives the menu and the tabs it closes.
              onClick={() => actions.start(withFocus(closeFiles(closeFor(label)), 'strip', true))}>
              {label}
            </Menu.Item>
          ))}
          <Menu.Item
            {...stylex.props(overlays.option)}
            onClick={() => actions.reorder(checkout, path, openFiles.indexOf(path) - 1)}>
            Move tab left
          </Menu.Item>
          <Menu.Item
            {...stylex.props(overlays.option)}
            onClick={() => actions.reorder(checkout, path, openFiles.indexOf(path) + 1)}>
            Move tab right
          </Menu.Item>
          <Menu.Item
            {...stylex.props(overlays.option)}
            disabled={!current || current.saving || preserving}
            onClick={() => run(actions.save(file))}>
            {current?.pendingSave ? 'Retry Save' : 'Save'}
          </Menu.Item>
          <Menu.SubmenuRoot>
            <Menu.SubmenuTrigger {...stylex.props(overlays.option)}>
              File view <Icon name="chevronRight" />
            </Menu.SubmenuTrigger>
            <Menu.Portal>
              <Menu.Positioner {...stylex.props(overlays.positioner)}>
                <Menu.Popup {...stylex.props(overlays.popup, overlays.options)}>
                  <Menu.RadioGroup
                    aria-label="File view"
                    value={fileView}
                    onValueChange={(view: FileView) => run(actions.open(file, { view }))}>
                    {(git
                      ? (['file', 'staged', 'unstaged', 'untracked'] as const)
                      : (['file'] as const)
                    ).map((view) => (
                      <Menu.RadioItem
                        key={view}
                        value={view}
                        closeOnClick
                        {...stylex.props(
                          overlays.option,
                          fileView === view && workbench.fileSelected,
                        )}>
                        {view === 'file' ? 'File' : view}
                      </Menu.RadioItem>
                    ))}
                    {(current?.conflict || fileView === 'conflict') && (
                      <Menu.RadioItem
                        value="conflict"
                        closeOnClick
                        {...stylex.props(
                          overlays.option,
                          fileView === 'conflict' && workbench.fileSelected,
                        )}>
                        Save conflict
                      </Menu.RadioItem>
                    )}
                  </Menu.RadioGroup>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.SubmenuRoot>
          <Menu.Item
            {...stylex.props(overlays.option)}
            onClick={() => run(actions.reopen(checkout))}>
            Reopen Closed Files
          </Menu.Item>
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  );
}
