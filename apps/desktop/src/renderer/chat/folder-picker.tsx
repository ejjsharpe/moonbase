import { useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Popover } from '@base-ui/react/popover';
import { controls } from '@moonbase/ui/controls';
import { overlays } from '@moonbase/ui/overlays';
import { projectHue, projectInitials, projectTiles } from '@moonbase/ui/projects';
import { colors, radius } from '@moonbase/ui/tokens.stylex';
import { Icon } from '../icon.tsx';
import { FolderMenu, folderMenuStyles, folderName, parentPath } from '../folder-menu.tsx';

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
  /** Offers a chat without a project, which runs in a new empty folder; chosen while `cwd` is empty. */
  noProject?: () => void;
  disabled?: boolean;
};

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
  noProject,
  disabled = false,
}: FolderPickerProps) {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<readonly string[]>([]);
  const focusTarget = useRef<HTMLElement>(null);
  // Open projects first, then the rest; a linked worktree only while it is open.
  const listed = projects
    .filter((project) => project.open || project.worktree === 'main')
    .sort((a, b) => Number(b.open) - Number(a.open));
  const roots = new Set(projects.map((project) => project.root));
  const others = recent.filter((folder) => !roots.has(folder));
  const current = projects.find((project) => project.root === cwd);
  const name = cwd ? folderName(cwd) : '';
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
        title={cwd || (noProject ? 'No project · runs in a new empty folder' : undefined)}
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
        <span {...stylex.props(controls.truncate)}>{name || (noProject ? 'No project' : 'Folder')}</span>
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
            initialFocus={() => focusTarget.current ?? true}
            {...stylex.props(folderMenuStyles.popup)}>
            <FolderMenu
              focusRef={(element) => {
                focusTarget.current = element;
              }}
              none={
                noProject && {
                  label: 'No project',
                  detail: 'A new empty folder',
                  chosen: !cwd,
                  choose: () => {
                    noProject();
                    setOpen(false);
                  },
                }
              }
              groups={[
                {
                  label: 'Projects',
                  items: listed.map((project) => ({
                    path: project.root,
                    projectId: project.projectId,
                    detail:
                      project.worktree === 'linked'
                        ? `${project.branch} · worktree`
                        : project.branch,
                    badge: project.open ? 'open' : undefined,
                    chosen: project.root === cwd,
                  })),
                },
                {
                  label: 'Recent folders',
                  items: others.map((folder) => ({
                    path: folder,
                    detail: parentPath(folder),
                    chosen: folder === cwd,
                  })),
                },
              ]}
              choose={(folder) => {
                choose(folder);
                setOpen(false);
              }}
              browse={
                browse &&
                (() => {
                  setOpen(false);
                  browse();
                })
              }
              browseLabel="Choose folder…"
              empty="Folders you open or choose for a chat appear here."
            />
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
});
