import { useRef } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@base-ui/react/button';
import { Tabs } from '@base-ui/react/tabs';
import { ContextMenu as Menu } from '@base-ui/react/context-menu';
import { motion, type Transition } from 'motion/react';
import { controls } from '@moonbase/ui/controls';
import { fileTypeMark } from '@moonbase/ui/files';
import { workbench } from '@moonbase/ui/workbench';
import { Icon } from '@moonbase/ui/icons';
import { FileIcon } from '@moonbase/ui/file-icons';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { fileKey, type EditorSnapshot, type CheckoutView } from '@moonbase/application/editor';
import type { FocusReturn } from '../focus-return.ts';
import { EditorTabMenu } from './editor-tab-menu.tsx';
import type { EditorActions } from '../editor-actions.ts';

/** A tab dragged along the strip: started on one tab and dropped onto another's place. */
export type TabDrag = {
  start(path: string): void;
  end(): void;
  /** Whether a tab is being dragged, rather than something from elsewhere. */
  dragging(): boolean;
  /** Moves the dragged tab to `path`'s place. */
  drop(path: string): void;
};

/** As much of `path`'s folder as tells it from the other open tabs with its name. */
export function findTabHint(path: string, openFiles: readonly string[]) {
  const parts = path.split('/');
  for (let count = 1; count <= parts.length; count++) {
    const tail = parts.slice(-count).join('/');
    if (
      !openFiles.some(
        (other) => other !== path && other.split('/').slice(-count).join('/') === tail,
      )
    )
      return parts.slice(-count, -1).join('/');
  }
  return '';
}

/**
 * One open file's tab: its type, name and folder hint, a close button that shows unsaved changes,
 * and its right-click menu. Tabs drag to reorder; a drag from elsewhere passes through to the app.
 */
export function EditorTab({
  actions,
  state,
  checkout,
  view,
  path,
  git,
  tabMotion,
  drag,
  tabRef,
  run,
  closeFiles,
  withFocus,
}: {
  actions: EditorActions;
  state: EditorSnapshot;
  checkout: CheckoutTarget;
  view: CheckoutView;
  path: string;
  git: boolean;
  tabMotion: Transition;
  /** The strip's tab drag, which tabs start and drop onto one another. */
  drag: TabDrag;
  tabRef: (element: HTMLElement | null) => void | (() => void);
  run: (work: Promise<unknown>) => void;
  closeFiles: (paths: string[]) => Promise<boolean>;
  withFocus: FocusReturn['withFocus'];
}) {
  // The tabs open when the menu opened, which its Close commands act on.
  const captured = useRef<string[]>([]),
    keyboard = useRef(false);
  const file = { checkout, path },
    current = state.buffers.find((buffer) => fileKey(buffer.target) === fileKey(file)),
    dirty = current && current.text !== current.disk.text;
  const fileView = view.fileViews.get(path) || 'file';
  const label = path.split('/').at(-1)!,
    hint = findTabHint(path, view.openFiles);
  const mark = fileTypeMark(path);
  return (
    <Menu.Root
      disabled={state.holdingUnsaved}
      onOpenChange={(open) => {
        if (open) captured.current = [...view.openFiles];
        else keyboard.current = false;
      }}>
      <Menu.Trigger
        render={
          <motion.span
            layout="position"
            initial={{ opacity: 0, width: 0 }}
            animate={{ opacity: 1, width: 'auto' }}
            exit={{ opacity: 0, width: 0, pointerEvents: 'none' }}
            transition={tabMotion}
          />
        }
        onKeyDown={(event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            keyboard.current = true;
            const bounds = event.currentTarget.getBoundingClientRect();
            event.currentTarget.dispatchEvent(
              new MouseEvent('contextmenu', {
                bubbles: true,
                cancelable: true,
                clientX: bounds.left,
                clientY: bounds.bottom,
              }),
            );
          }
        }}
        {...stylex.props(
          stylex.defaultMarker(),
          workbench.fileTab,
          view.active === path && workbench.activeFileTab,
        )}
        onDragOver={(event) => {
          if (drag.dragging()) event.preventDefault();
        }}
        onDrop={(event) => {
          // Only a tab drag is the tabs'; files from the OS pass through to the app.
          if (!drag.dragging()) return;
          event.preventDefault();
          drag.drop(path);
        }}>
        <Tabs.Tab
          ref={tabRef}
          value={path}
          aria-label={path}
          title={`${checkout.hostId} · ${checkout.root}/${path}`}
          aria-description={
            [view.preview === path && 'Preview', dirty && 'Unsaved'].filter(Boolean).join(', ') ||
            undefined
          }
          draggable={!state.holdingUnsaved}
          onDragStart={(event) => {
            drag.start(path);
            event.dataTransfer.setData('text/plain', path);
          }}
          onDragEnd={drag.end}
          onDoubleClick={() => actions.keepOpen(file)}
          {...stylex.props(
            controls.button,
            workbench.tabButton,
            workbench.fileTabButton,
            view.preview === path && workbench.preview,
          )}>
          {mark ? (
            <span aria-hidden="true" {...stylex.props(mark.style)}>
              {mark.label}
            </span>
          ) : (
            <span {...stylex.props(controls.icon)}>
              <FileIcon path={path} />
            </span>
          )}
          <span {...stylex.props(controls.truncate)}>{label}</span>
          {hint && (
            <span aria-hidden="true" {...stylex.props(workbench.fileTabHint)}>
              {hint}
            </span>
          )}
        </Tabs.Tab>
        <Button
          {...stylex.props(
            controls.button,
            controls.iconButton,
            workbench.tabClose,
            workbench.fileTabClose,
            workbench.revealTabClose,
            (view.active === path || dirty) && workbench.visibleTabClose,
          )}
          aria-label={`Close ${path}`}
          disabled={state.holdingUnsaved}
          onClick={() => run(closeFiles([path]))}>
          {dirty ? (
            <>
              <span aria-hidden="true" {...stylex.props(workbench.unsavedDot)} />
              <span {...stylex.props(workbench.unsavedClose)}>
                <Icon name="close" />
              </span>
            </>
          ) : (
            <Icon name="close" />
          )}
        </Button>
      </Menu.Trigger>
      <EditorTabMenu
        actions={actions}
        holdingUnsaved={state.holdingUnsaved}
        file={file}
        buffer={current}
        openFiles={view.openFiles}
        captured={captured}
        fileView={fileView}
        git={git}
        openedByKeyboard={() => {
          const opened = keyboard.current;
          keyboard.current = false;
          return opened;
        }}
        run={run}
        closeFiles={closeFiles}
        withFocus={withFocus}
      />
    </Menu.Root>
  );
}
