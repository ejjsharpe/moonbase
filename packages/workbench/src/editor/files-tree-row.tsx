import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import type { GitChangeKind } from '@moonbase/contracts/workspace';
import { filesUI, gitStatusHues, gitStatusUI } from '@moonbase/ui/files';
import { styles } from './styles.ts';
import { Icon } from './icon.tsx';
import { rowHeight, type VisibleRow } from './files-tree-rows.ts';
import { gitStatusMarks } from './files-tree-status.ts';

const isContextClick = (event: { button: number; ctrlKey: boolean }) =>
  event.button === 2 || (event.button === 0 && event.ctrlKey && navigator.platform.includes('Mac'));

/** One `treeitem` of the files tree, placed at its index in the virtualized extent. */
export function FilesTreeRow({
  id,
  row,
  index,
  expanded,
  selected,
  focused,
  active,
  dirty,
  cut,
  status,
  label,
  editor,
  draggable,
  dropTarget,
  onOpenMenu,
  onSelect,
  onOpen,
}: {
  /** The element id `aria-activedescendant` names. */
  id: string;
  row: VisibleRow;
  index: number;
  expanded: boolean;
  selected: boolean;
  focused: boolean;
  active: boolean;
  dirty: boolean;
  /** Whether the entry, or a folder it is in, is cut and waiting to be pasted. */
  cut: boolean;
  /** A file's strongest Git change, or a folder's strongest changed descendant's. */
  status?: GitChangeKind;
  /** The accessible name, when it isn't the row's path, such as a placeholder's. */
  label?: string;
  /** The name field shown in place of the name while it's typed. */
  editor?: ReactNode;
  /** Whether the row can be dragged to move it; the tree handles the drag. */
  draggable: boolean;
  /** Whether the row is in the region a drag in progress would drop into. */
  dropTarget: boolean;
  /** Opens the context menu for this row at a point in the viewport. */
  onOpenMenu: (path: string, x: number, y: number) => void;
  /** A primary click; `additive` when ⌘ (Ctrl off a Mac) was held. */
  onSelect: (row: VisibleRow, additive: boolean) => void;
  /** Opens this row's file to keep. */
  onOpen: (path: string) => void;
}) {
  const folderIcon = expanded ? 'folderOpen' : 'folder';
  let statusLabel = '';
  if (status && !row.directory) statusLabel = ', ' + gitStatusMarks[status].label;
  else if (status)
    statusLabel = status === 'conflicted' ? ', contains conflicts' : ', contains changes';
  return (
    <div
      id={id}
      role="treeitem"
      tabIndex={-1}
      aria-level={row.level}
      aria-posinset={row.position}
      aria-setsize={row.size}
      aria-expanded={row.directory ? expanded : undefined}
      aria-selected={selected}
      aria-current={active ? 'true' : undefined}
      aria-label={
        label ?? row.path + (dirty ? ', unsaved' : '') + (cut ? ', cut' : '') + statusLabel
      }
      aria-description={row.ignored ? 'Git-ignored' : undefined}
      draggable={draggable}
      data-drop-target={dropTarget || undefined}
      {...stylex.props(
        styles.treeRow(index * rowHeight),
        filesUI.row(row.level),
        row.ignored && filesUI.ignored,
        selected && filesUI.selected,
        focused && filesUI.focused,
        dropTarget && filesUI.dropRegion,
        cut && filesUI.cut,
      )}
      onContextMenu={(event) => {
        if (!event.currentTarget.contains(event.target as Node)) return;
        event.preventDefault();
        event.stopPropagation();
        onOpenMenu(row.path, event.clientX, event.clientY);
      }}
      onPointerDown={(event) => {
        if (isContextClick(event)) event.preventDefault();
      }}
      onMouseDown={(event) => {
        // Pressing beside a name field keeps the name being typed.
        if (editor) event.preventDefault();
      }}
      onClick={(event) => {
        if (
          !event.currentTarget.contains(event.target as Node) ||
          event.button !== 0 ||
          isContextClick(event)
        )
          return;
        onSelect(row, event.metaKey || event.ctrlKey);
      }}
      onDoubleClick={(event) => {
        if (event.button !== 0 || isContextClick(event)) return;
        if (!row.directory) onOpen(row.path);
      }}>
      <span
        aria-hidden="true"
        {...stylex.props(filesUI.disclosure, row.directory && expanded && filesUI.rotated)}>
        {row.directory && <Icon name="chevronRight" />}
      </span>
      <Icon name={row.directory ? folderIcon : 'file'} />
      {editor ?? (
        <span
          {...stylex.props(
            styles.treeLabel,
            active && filesUI.activeLabel,
            status && !row.directory && gitStatusHues[status],
            row.ignored && filesUI.ignored,
          )}>
          {row.path.split('/').at(-1)}
        </span>
      )}
      {!editor && (dirty || status) && (
        <span aria-hidden="true" {...stylex.props(gitStatusUI.slot)}>
          {dirty && <span>•</span>}
          {status &&
            (row.directory ? (
              <span
                data-git-status={status}
                {...stylex.props(
                  gitStatusUI.dot,
                  status === 'conflicted' && gitStatusUI.conflictDot,
                  gitStatusHues[status],
                )}
              />
            ) : (
              <span
                data-git-status={status}
                {...stylex.props(gitStatusUI.letter, gitStatusHues[status])}>
                {gitStatusMarks[status].letter}
              </span>
            ))}
        </span>
      )}
    </div>
  );
}
