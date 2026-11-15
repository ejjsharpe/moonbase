import * as stylex from '@stylexjs/stylex';
import { Autocomplete } from '@base-ui/react/autocomplete';
import { projectHue, projectInitials, projectTiles } from '@moonbase/ui/projects';
import { Icon } from '@moonbase/ui/icons';
import { FileIcon } from '@moonbase/ui/file-icons';
import { groupGoToRows, type GoToRow } from './go-to-rows.ts';
import { MarkedText } from './marked-text.tsx';
import { styles } from './picker-styles.ts';

const rowIcons = { chat: 'agents', command: 'chevronRight' } as const;

/** Go to's rows under their group headings; each item's value is its row key. */
export function GoToList({
  rows,
  activate,
}: {
  rows: GoToRow[];
  activate: (row: GoToRow) => void;
}) {
  let at = 0;
  return groupGoToRows(rows).map(({ group, rows: grouped }, i) => (
    <Autocomplete.Group key={group + ':' + i} {...stylex.props(styles.group)}>
      {group && (
        <Autocomplete.GroupLabel {...stylex.props(styles.heading)}>{group}</Autocomplete.GroupLabel>
      )}
      {grouped.map((row) => (
        <GoToItem key={row.key} row={row} index={at++} activate={activate} />
      ))}
    </Autocomplete.Group>
  ));
}

function GoToItem({
  row,
  index,
  activate,
}: {
  row: GoToRow;
  index: number;
  activate: (row: GoToRow) => void;
}) {
  const slash = row.kind === 'file' ? row.label.lastIndexOf('/') : -1;
  return (
    <Autocomplete.Item
      value={row.key}
      index={index}
      // A file's accessible name is its whole path, not its split display.
      aria-label={row.label}
      {...stylex.props(styles.row)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => activate(row)}>
      {row.kind === 'project' ? (
        <span
          aria-hidden="true"
          data-initials={projectInitials(row.label)}
          {...stylex.props(projectTiles.tile, styles.tile, projectHue(row.projectId ?? row.label))}
        />
      ) : (
        <span {...stylex.props(styles.icon)}>
          {row.kind === 'file' ? <FileIcon path={row.label} /> : <Icon name={rowIcons[row.kind]} />}
        </span>
      )}
      <span {...stylex.props(styles.label)}>
        <MarkedText
          text={row.label.slice(slash + 1)}
          positions={row.positions}
          offset={slash + 1}
        />
      </span>
      {slash > 0 && (
        <span {...stylex.props(styles.detail, styles.path)}>
          <MarkedText text={row.label.slice(0, slash)} positions={row.positions} />
        </span>
      )}
      {(row.detail || row.shortcut) && (
        <span {...stylex.props(styles.detail, styles.trailing)}>{row.shortcut ?? row.detail}</span>
      )}
    </Autocomplete.Item>
  );
}
