import { useId, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { projectHue, projectInitials, projectTiles } from '@moonbase/ui/projects';
import { colors, radius, shadow, space, type } from '@moonbase/ui/tokens.stylex';
import { Icon } from './icon.tsx';

export type FolderMenuItem = {
  path: string;
  /** Colours the tile as the project's; a folder outside any project is silver. */
  projectId?: string;
  detail: string;
  badge?: string;
  chosen?: boolean;
};
export type FolderMenuGroup = { label: string; items: readonly FolderMenuItem[] };

export const folderName = (path: string) => path.split('/').filter(Boolean).at(-1) || '/';
/** A path with the home folder written as ~. */
export const homePath = (path: string) => path.replace(/^\/(Users|home)\/[^/]+/, '~');
export const parentPath = (path: string) => homePath(path.replace(/\/[^/]+\/?$/, '') || '/');
/** Past this many folders the menu offers a filter. */
const filterAbove = 8;

/**
 * The body of a popover that picks a project or folder: grouped rows, a filter once the list is
 * long, and a footer for the native picker. The consumer owns the popover and its trigger.
 */
export function FolderMenu({
  groups,
  choose,
  browse,
  browseLabel,
  browseShortcut,
  empty,
  focusRef,
  none,
}: {
  groups: readonly FolderMenuGroup[];
  /** A first row choosing no folder at all, such as a chat without a project. */
  none?: { label: string; detail: string; chosen: boolean; choose(): void };
  choose(path: string): void;
  browse?: () => void;
  browseLabel: string;
  browseShortcut?: string;
  empty: string;
  /** Receives what the popover should focus when it opens: the filter, else the chosen row. */
  focusRef?: (element: HTMLElement | null) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  const filtering = total > filterAbove;
  const needle = query.trim().toLowerCase();
  const shown = groups
    .map((group) => ({
      ...group,
      items: needle
        ? group.items.filter(
            (item) =>
              folderName(item.path).toLowerCase().includes(needle) ||
              item.path.toLowerCase().includes(needle),
          )
        : group.items,
    }))
    .filter((group) => group.items.length);
  const flat = shown.flatMap((group) => group.items);
  const current = Math.min(active, flat.length - 1);
  return (
    <>
      {filtering && (
        <label {...stylex.props(styles.filter)}>
          <Icon name="search" />
          <input
            ref={focusRef}
            aria-label="Filter folders"
            placeholder="Filter…"
            value={query}
            {...stylex.props(styles.filterInput)}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                setActive((current + step + flat.length) % Math.max(flat.length, 1));
              } else if (event.key === 'Enter' && flat[current]) {
                event.preventDefault();
                choose(flat[current].path);
              }
            }}
          />
          <span aria-hidden="true" {...stylex.props(styles.keys)}>
            ↑↓ ⏎
          </span>
        </label>
      )}
      <div {...stylex.props(styles.list)}>
        {none && !needle && (
          <button
            type="button"
            aria-pressed={none.chosen}
            ref={none.chosen && !filtering ? focusRef : undefined}
            {...stylex.props(styles.item, none.chosen && styles.chosen)}
            onClick={none.choose}>
            <span aria-hidden="true" {...stylex.props(styles.noneIcon)}>
              <Icon name="folder" />
            </span>
            <span {...stylex.props(styles.itemText)}>
              <span {...stylex.props(controls.truncate)}>{none.label}</span>
              <span {...stylex.props(controls.truncate, styles.detail)}>{none.detail}</span>
            </span>
            <span aria-hidden="true" {...stylex.props(styles.check)}>
              {none.chosen ? '✓' : ''}
            </span>
          </button>
        )}
        {shown.map((group, index) => (
          <div
            key={group.label}
            role="group"
            aria-labelledby={`${id}-${index}`}
            {...stylex.props(styles.group)}>
            <span id={`${id}-${index}`} {...stylex.props(styles.heading)}>
              {group.label}
            </span>
            {group.items.map((item) => {
              const highlighted = filtering && needle !== '' && flat[current] === item;
              return (
                <button
                  key={item.path}
                  type="button"
                  aria-pressed={!!item.chosen}
                  title={item.path}
                  ref={item.chosen && !filtering ? focusRef : undefined}
                  {...stylex.props(
                    styles.item,
                    item.chosen && styles.chosen,
                    highlighted && styles.highlighted,
                  )}
                  onClick={() => choose(item.path)}>
                  <span
                    aria-hidden="true"
                    data-initials={projectInitials(folderName(item.path))}
                    {...stylex.props(
                      projectTiles.tile,
                      item.projectId ? projectHue(item.projectId) : projectTiles.silver,
                      styles.itemTile,
                    )}
                  />
                  <span {...stylex.props(styles.itemText)}>
                    <span {...stylex.props(controls.truncate)}>{folderName(item.path)}</span>
                    <span {...stylex.props(controls.truncate, styles.detail)}>{item.detail}</span>
                  </span>
                  {item.badge && <span {...stylex.props(styles.badge)}>{item.badge}</span>}
                  <span aria-hidden="true" {...stylex.props(styles.check)}>
                    {item.chosen ? '✓' : ''}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
        {!shown.length && (
          <p {...stylex.props(styles.empty)}>{needle ? 'Nothing matches.' : empty}</p>
        )}
      </div>
      {browse && (
        <button type="button" {...stylex.props(styles.footer)} onClick={browse}>
          <Icon name="folder" />
          {browseLabel}
          {browseShortcut && <span {...stylex.props(styles.shortcut)}>{browseShortcut}</span>}
        </button>
      )}
    </>
  );
}

export const folderMenuStyles = stylex.create({
  popup: {
    width: 'min(320px, calc(100vw - 24px))',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    fontFamily: type.ui,
    fontSize: type.body,
    color: colors.text,
    backgroundColor: colors.elevated,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.controlBorder,
    borderRadius: radius.panel,
    boxShadow: shadow.raised,
    outline: 'none',
  },
});

const styles = stylex.create({
  filter: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    height: 38,
    flexShrink: 0,
    paddingInline: 12,
    color: colors.muted,
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.border,
  },
  filterInput: {
    flex: 1,
    minWidth: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: colors.text,
    font: 'inherit',
    fontSize: type.small,
    outline: 'none',
  },
  keys: { flexShrink: 0, fontSize: type.caption },
  list: {
    maxHeight: 'min(340px, 50vh)',
    overflowY: 'auto',
    padding: 6,
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
  },
  group: { display: 'flex', flexDirection: 'column', gap: 1 },
  heading: {
    padding: '4px 8px 2px',
    color: colors.muted,
    fontSize: 10.5,
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    minWidth: 0,
    flexShrink: 0,
    padding: '5px 8px',
    borderWidth: 0,
    borderRadius: radius.row,
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
    color: colors.text,
    font: 'inherit',
    fontSize: type.small,
    textAlign: 'left',
    cursor: 'pointer',
  },
  chosen: { backgroundColor: { default: colors.selected, ':hover': colors.selectedHover } },
  highlighted: {
    backgroundColor: { default: colors.hover, ':hover': colors.hover },
    outlineWidth: 1,
    outlineStyle: 'solid',
    outlineColor: colors.text,
    outlineOffset: -1,
  },
  itemTile: { width: 22, height: 22, borderRadius: 6, fontSize: 10 },
  noneIcon: {
    display: 'grid',
    placeItems: 'center',
    flexShrink: 0,
    width: 22,
    height: 22,
    color: colors.muted,
  },
  itemText: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', lineHeight: 1.3 },
  detail: { color: colors.muted, fontSize: type.caption },
  badge: { flexShrink: 0, color: colors.muted, fontSize: type.caption },
  check: { flexShrink: 0, width: 12, color: colors.text },
  empty: { margin: 0, padding: space.md, color: colors.muted, fontSize: type.small },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    flexShrink: 0,
    padding: '8px 12px',
    borderWidth: 0,
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.border,
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
    color: colors.secondary,
    font: 'inherit',
    fontSize: type.small,
    textAlign: 'left',
    cursor: 'pointer',
  },
  shortcut: { marginLeft: 'auto', color: colors.muted },
});
