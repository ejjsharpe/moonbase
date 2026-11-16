import { useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { workbench } from '@moonbase/ui/workbench';
import { SidebarResize } from './sidebar-resize.tsx';

/**
 * The workbench's default layout: the explorer in a resizable sidebar beside the editor, then the
 * app's `trailing` content. Hidden, the sidebar slides closed; hiding it while focus is in it calls
 * `onHiddenWithFocus` to hand focus on rather than leave it to the page.
 */
export function SidebarLayout({
  width,
  hidden,
  resize,
  onHiddenWithFocus,
  explorer,
  editor,
  trailing,
}: {
  width: number;
  hidden: boolean;
  resize: (width: number) => void;
  onHiddenWithFocus: () => void;
  explorer: ReactNode;
  editor: ReactNode;
  trailing?: ReactNode;
}) {
  const [resizing, setResizing] = useState(false);
  const focusInSidebar = useRef(false);
  const handFocusOn = useEffectEvent(onHiddenWithFocus);
  useLayoutEffect(() => {
    if (!hidden || !focusInSidebar.current) return;
    focusInSidebar.current = false;
    handFocusOn();
  }, [hidden]);
  return (
    <div {...stylex.props(styles.layout, !!trailing && workbench.withTrailing)}>
      <div {...stylex.props(workbench.sidebarLayout(width))}>
        <div
          {...stylex.props(
            workbench.workspace,
            hidden && workbench.workspaceSolo,
            resizing && workbench.workspaceStill,
          )}>
          {!hidden && <SidebarResize width={width} resize={resize} onResizing={setResizing} />}
          {/* Kept while hidden, so it slides closed with its contents. */}
          <aside
            onFocusCapture={() => (focusInSidebar.current = true)}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget))
                focusInSidebar.current = false;
            }}
            inert={hidden}
            {...stylex.props(workbench.sidebar, hidden && workbench.sidebarClosed)}
            aria-label="Editor sidebar">
            {explorer}
          </aside>
          {editor}
        </div>
      </div>
      {trailing}
    </div>
  );
}

const styles = stylex.create({
  layout: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 },
});
