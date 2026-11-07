import { useId, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Popover } from '@base-ui/react/popover';
import { controls } from '@moonbase/ui/controls';
import { overlays } from '@moonbase/ui/overlays';
import { projectHue, projectInitials, projectTiles } from '@moonbase/ui/projects';
import { colors, radius, shadow, space, type } from '@moonbase/ui/tokens.stylex';
import { Icon } from '../icon.tsx';

/** A checkout the editor has opened, which local chat may use as its working folder. */
export type ChatFolderProject = {
  root: string;
  projectId: string;
  branch: string;
  worktree: 'main' | 'linked';
  /** Whether it is open in the editor now. */
  open: boolean;
};

export type FolderPickerProps = {
  cwd: string;
  projects: readonly ChatFolderProject[];
  /** Folders the native picker approved before, newest first; read each time the menu opens. */
  recentFolders?: () => Promise<readonly string[]>;
  choose(folder: string): void;
  /** Opens the native folder picker. */
  browse?: () => void;
  disabled?: boolean;
};

const folderName = (path: string) => path.split('/').filter(Boolean).at(-1) || '/';
const parentPath = (path: string) =>
  (path.replace(/\/[^/]+\/?$/, '') || '/').replace(/^\/(Users|home)\/[^/]+/, '~');

/**
 * The new local chat's working folder: one chip that names it, and a menu of the editor's
 * projects and recently chosen folders, with the native picker for any other.
 */
export function FolderPicker({
  cwd,
  projects,
  recentFolders,
  choose,
  browse,
  disabled = false,
}: FolderPickerProps) {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<readonly string[]>([]);
  const chosenButton = useRef<HTMLButtonElement>(null);
  const id = useId();
  // Open projects first, then the rest; a linked worktree only while it is open.
  const listed = projects
    .filter((project) => project.open || project.worktree === 'main')
    .sort((a, b) => Number(b.open) - Number(a.open));
  const roots = new Set(projects.map((project) => project.root));
  const others = recent.filter((folder) => !roots.has(folder));
  const current = projects.find((project) => project.root === cwd);
  const name = cwd ? folderName(cwd) : '';
  const pick = (folder: string) => {
    choose(folder);
    setOpen(false);
  };
  const row = (folder: string, detail: string, tile: stylex.StyleXStyles, live = false) => {
    const chosen = folder === cwd;
    return (
      <button
        key={folder}
        type="button"
        aria-pressed={chosen}
        title={folder}
        ref={chosen ? chosenButton : undefined}
        {...stylex.props(styles.item, chosen && styles.chosen)}
        onClick={() => pick(folder)}>
        <span
          aria-hidden="true"
          data-initials={projectInitials(folderName(folder))}
          {...stylex.props(projectTiles.tile, tile, styles.itemTile)}
        />
        <span {...stylex.props(styles.itemText)}>
          <span {...stylex.props(controls.truncate)}>{folderName(folder)}</span>
          <span {...stylex.props(controls.truncate, styles.detail)}>{detail}</span>
        </span>
        {live && <span {...stylex.props(styles.badge)}>open</span>}
        <span aria-hidden="true" {...stylex.props(styles.check)}>
          {chosen ? '✓' : ''}
        </span>
      </button>
    );
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && recentFolders)
          void recentFolders()
            .then(setRecent)
            .catch(() => setRecent([]));
      }}>
      <Popover.Trigger
        aria-label="Choose working folder"
        title={cwd || undefined}
        disabled={disabled}
        {...stylex.props(controls.button, controls.quietButton, styles.chip)}>
        {name ? (
          <span
            aria-hidden="true"
            data-initials={projectInitials(name)}
            {...stylex.props(
              projectTiles.tile,
              current ? projectHue(current.projectId) : projectTiles.silver,
              styles.chipTile,
            )}
          />
        ) : (
          <Icon name="folder" />
        )}
        <span {...stylex.props(controls.truncate)}>{name || 'Folder'}</span>
        <span aria-hidden="true" {...stylex.props(styles.caret)}>
          ▾
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          {...stylex.props(overlays.positioner)}>
          <Popover.Popup
            aria-label="Working folder"
            initialFocus={() => chosenButton.current ?? true}
            {...stylex.props(styles.popup)}>
            <div {...stylex.props(styles.list)}>
              {listed.length > 0 && (
                <div
                  role="group"
                  aria-labelledby={`${id}-projects`}
                  {...stylex.props(styles.group)}>
                  <span id={`${id}-projects`} {...stylex.props(styles.heading)}>
                    Projects
                  </span>
                  {listed.map((project) =>
                    row(
                      project.root,
                      project.worktree === 'linked'
                        ? `${project.branch} · worktree`
                        : project.branch,
                      projectHue(project.projectId),
                      project.open,
                    ),
                  )}
                </div>
              )}
              {others.length > 0 && (
                <div role="group" aria-labelledby={`${id}-recent`} {...stylex.props(styles.group)}>
                  <span id={`${id}-recent`} {...stylex.props(styles.heading)}>
                    Recent folders
                  </span>
                  {others.map((folder) => row(folder, parentPath(folder), projectTiles.silver))}
                </div>
              )}
              {!listed.length && !others.length && (
                <p {...stylex.props(styles.empty)}>
                  Folders you open or choose for a chat appear here.
                </p>
              )}
            </div>
            {browse && (
              <button
                type="button"
                {...stylex.props(styles.footer)}
                onClick={() => {
                  setOpen(false);
                  browse();
                }}>
                <Icon name="folder" />
                Choose folder…
              </button>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

const styles = stylex.create({
  // Keeps its name beside the worktree and host chips; a long name truncates at the cap.
  chip: {
    height: 30,
    flexShrink: 0,
    maxWidth: 200,
    minWidth: 0,
    padding: '0 10px 0 8px',
    gap: 6,
    borderRadius: radius.row,
  },
  chipTile: { width: 18, height: 18, borderRadius: 5, fontSize: 9 },
  caret: { color: colors.muted },
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
  itemTile: { width: 22, height: 22, borderRadius: 6, fontSize: 10 },
  itemText: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', lineHeight: 1.3 },
  detail: { color: colors.muted, fontSize: type.caption },
  badge: { flexShrink: 0, color: colors.muted, fontSize: type.caption },
  check: { flexShrink: 0, width: 12, color: colors.text },
  empty: { margin: 0, padding: space.md, color: colors.muted, fontSize: type.small },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
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
});
