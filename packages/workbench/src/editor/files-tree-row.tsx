import * as stylex from '@stylexjs/stylex';
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
  status,
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
  /** A file's strongest Git change, or a folder's strongest changed descendant's. */
  status?: GitChangeKind;
  /** Opens the context menu for this row at a point in the viewport. */
  onOpenMenu: (path: string, x: number, y: number) => void;
  /** A primary click; `additive` when ⌘ (Ctrl off a Mac) was held. */
  onSelect: (row: VisibleRow, additive: boolean) => void;
  /** Opens this row's file to keep. */
  onOpen: (path: string) => void;
}) {
  const folderIcon = expanded ? 'folderOpen' : 'folder';
  let statusLabel = '';
  if (status)
    statusLabel = row.directory ? ', contains changes' : ', ' + gitStatusMarks[status].label;
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
      aria-label={row.path + (dirty ? ', unsaved' : '') + statusLabel}
      aria-description={row.ignored ? 'Git-ignored' : undefined}
      {...stylex.props(
        styles.treeRow(index * rowHeight),
        filesUI.row(row.level),
        row.ignored && filesUI.ignored,
        selected && filesUI.selected,
        focused && filesUI.focused,
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
      <span
        {...stylex.props(
          styles.treeLabel,
          active && filesUI.activeLabel,
          status && !row.directory && gitStatusHues[status],
          row.ignored && filesUI.ignored,
        )}>
        {row.path.split('/').at(-1)}
      </span>
      {(dirty || status) && (
        <span aria-hidden="true" {...stylex.props(gitStatusUI.slot)}>
          {dirty && <span>•</span>}
          {status &&
            (row.directory ? (
              <span
                data-git-status={status}
                {...stylex.props(gitStatusUI.dot, gitStatusHues[status])}
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
