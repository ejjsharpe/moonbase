import * as stylex from '@stylexjs/stylex';
import { workbench } from '@moonbase/ui/workbench';

const minWidth = 190,
  maxWidth = 380;

/**
 * The separator that resizes the sidebar: dragged, or with the arrow keys, Home and End.
 * `onResizing` reports a drag starting and ending, so the layout holds still meanwhile.
 */
export function SidebarResize({
  width,
  resize,
  onResizing,
}: {
  width: number;
  resize: (width: number) => void;
  onResizing: (resizing: boolean) => void;
}) {
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      {...stylex.props(workbench.sidebarResize)}
      onKeyDown={(event) => {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          let next = width + (event.key === 'ArrowRight' ? 10 : -10);
          if (event.key === 'Home') next = minWidth;
          else if (event.key === 'End') next = maxWidth;
          resize(next);
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        onResizing(true);
      }}
      onLostPointerCapture={() => onResizing(false)}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          resize(event.clientX - event.currentTarget.parentElement!.getBoundingClientRect().left);
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    />
  );
}
