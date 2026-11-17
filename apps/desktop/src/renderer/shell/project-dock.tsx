import { useState, type ComponentProps, type RefObject } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@moonbase/ui/tokens.stylex';
import { ChatView } from '../chat/chat-view.tsx';

const dockDefaultWidth = 400,
  dockMinWidth = 320;
const railWidth = (collapsed: boolean) => (collapsed ? 0 : 52);

/**
 * The project dock beside the editor: the project's chats, resized by dragging or keys at its left
 * edge, expanded to most of the view, or hidden (its chat view unmounts; the composer keeps what
 * it held).
 */
export function ProjectDock({
  dock,
  visible,
  railCollapsed,
  project,
  roots,
  cwd,
  collapse,
  chatKey,
  chat,
}: {
  dock: RefObject<HTMLElement | null>;
  visible: boolean;
  railCollapsed: boolean;
  /** The project's name, its folders and the folder a new chat starts in. */
  project: string;
  roots: readonly string[];
  cwd: string;
  collapse(): void;
  /** Mounts the chat view afresh for another chat target or project. */
  chatKey: string;
  /** The chat view's own props. */
  chat: Omit<ComponentProps<typeof ChatView>, 'dock'>;
}) {
  const [width, setWidth] = useState(dockDefaultWidth),
    [restoreWidth, setRestoreWidth] = useState(dockDefaultWidth),
    [resizing, setResizing] = useState(false);
  // The dock leaves the explorer and a usable editor beside it.
  const maxWidth = Math.max(dockMinWidth, window.innerWidth - railWidth(railCollapsed) - 560);
  const resize = (next: number) =>
    setWidth(Math.round(Math.min(Math.max(next, dockMinWidth), maxWidth)));
  const expanded = width >= maxWidth;
  const shownWidth = Math.min(width, maxWidth);
  return (
    <aside
      ref={dock}
      aria-label="Project chats"
      inert={!visible}
      {...stylex.props(
        styles.dock,
        visible ? styles.dockWidth(shownWidth) : styles.dockClosed,
        resizing && styles.dockStill,
      )}>
      {visible && (
        <div
          role="separator"
          tabIndex={0}
          aria-label="Resize project chats"
          aria-orientation="vertical"
          aria-valuemin={dockMinWidth}
          aria-valuemax={maxWidth}
          aria-valuenow={shownWidth}
          {...stylex.props(styles.dockResize)}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            // The edge is on the dock's left, so ArrowLeft widens it.
            let next = width + (event.key === 'ArrowLeft' ? 20 : -20);
            if (event.key === 'Home') next = dockMinWidth;
            else if (event.key === 'End') next = maxWidth;
            resize(next);
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            setResizing(true);
          }}
          onLostPointerCapture={() => setResizing(false)}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              resize(
                event.currentTarget.parentElement!.getBoundingClientRect().right - event.clientX,
              );
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
        />
      )}
      {visible && (
        <ChatView
          key={chatKey}
          {...chat}
          dock={{
            project,
            roots,
            cwd,
            expanded,
            toggleExpanded: () => {
              if (expanded) setWidth(restoreWidth);
              else {
                setRestoreWidth(width);
                setWidth(maxWidth);
              }
            },
            collapse,
          }}
        />
      )}
    </aside>
  );
}

const styles = stylex.create({
  // The project dock: that project's chats beside the editor.
  dock: {
    position: 'relative',
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 400,
    minWidth: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    borderLeftWidth: 1,
    borderLeftStyle: 'solid',
    borderLeftColor: colors.border,
    transitionProperty: 'flex-basis',
    transitionDuration: '160ms',
    transitionTimingFunction: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  },
  dockWidth: (width: number) => ({ flexBasis: width }),
  // Closed, the dock slides to nothing; the title bar's button and ⌘J bring it back.
  dockClosed: { flexBasis: 0, borderLeftWidth: 0 },
  dockStill: { transitionProperty: 'none' },
  // Dragging the dock's left edge resizes it, like the explorer's edge.
  dockResize: {
    position: 'absolute',
    zIndex: 5,
    top: 0,
    bottom: 0,
    left: -3,
    width: 6,
    cursor: 'col-resize',
    touchAction: 'none',
    outline: 'none',
    backgroundColor: {
      default: 'transparent',
      ':hover': colors.accent,
      ':focus-visible': colors.accent,
    },
  },
});
