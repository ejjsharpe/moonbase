import * as stylex from '@stylexjs/stylex';
import { colors, space, syntax, type } from '@moonbase/ui/tokens.stylex';
import { useAtomValue } from '@effect/atom-react';
import { Choice } from '../choice.tsx';
import { FolderPicker, type ChatFolderProject } from '../folder-picker.tsx';
import type { ChatHosts } from '../chat-view.tsx';
import { useChat } from '../chat-context.ts';

/**
 * Where a new chat runs: its working folder (or none, in a project's dock always the project's),
 * whether its first message makes a worktree there, and the host.
 */
export function NewChatPlace({
  cwd,
  newWorktree,
  worktreeChoice,
  disabled,
  folderProjects,
  recentFolders,
  hosts,
  inDock,
  chooseFolder,
  chooseNoProject,
  chooseWorktree,
  browse,
}: {
  cwd: string;
  newWorktree: boolean;
  /** Whether the folder can have a new worktree made for the chat. */
  worktreeChoice: boolean;
  disabled: boolean;
  folderProjects: readonly ChatFolderProject[];
  recentFolders?: () => Promise<readonly string[]>;
  hosts?: ChatHosts;
  inDock: boolean;
  chooseFolder(folder: string): void;
  chooseNoProject(): void;
  chooseWorktree(newWorktree: boolean): void;
  /** Picks a folder in the native picker; absent where it can't (a remote host's chats). */
  browse?: () => void;
}) {
  const { remote, ready: connected, connection } = useAtomValue(useChat().atoms.link);
  const hostDot = (
    <span
      aria-hidden="true"
      {...stylex.props(
        styles.localDot,
        remote && !connected && styles.offlineDot,
        remote && connection?.state === 'connecting' && styles.pendingDot,
      )}
    />
  );
  return (
    <div {...stylex.props(styles.context)}>
      <FolderPicker
        cwd={cwd}
        projects={remote ? [] : folderProjects}
        recentFolders={recentFolders}
        hostFolders={
          remote
            ? {
                label: 'On the host',
                empty: 'The host offers no folders. Add approved roots to its daemon.json.',
              }
            : undefined
        }
        disabled={disabled}
        // A project's dock keeps its chats in the project.
        noProject={inDock ? undefined : chooseNoProject}
        choose={chooseFolder}
        browse={browse}
      />
      {worktreeChoice && (
        <div {...stylex.props(styles.worktreeChoice)}>
          <Choice
            compact
            label="Worktree"
            value={newWorktree ? 'new' : 'folder'}
            options={[
              { value: 'folder', label: 'This folder' },
              { value: 'new', label: 'New worktree' },
            ]}
            onChange={(value) => chooseWorktree(value === 'new')}
            disabled={disabled}
          />
        </div>
      )}
      {hosts && hosts.targets.length > 1 ? (
        <div {...stylex.props(styles.hostChoice)}>
          <Choice
            compact
            label="Chat target"
            value={hosts.current ?? ''}
            options={hosts.targets.map(({ id, label }) => ({ value: id, label }))}
            onChange={(id) => id !== hosts.current && hosts.select(id)}
            disabled={hosts.disabled || disabled}
            leading={hostDot}
          />
        </div>
      ) : (
        <span {...stylex.props(styles.localLabel)}>
          {hostDot}
          {hosts?.targets.find((target) => target.id === hosts.current)?.label ??
            (remote ? 'remote' : 'local')}
        </span>
      )}
    </div>
  );
}

const styles = stylex.create({
  context: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.sm,
    rowGap: 4,
    minWidth: 0,
    marginRight: 'auto',
  },
  worktreeChoice: { flexShrink: 0 },
  hostChoice: { flexShrink: 0, maxWidth: 200 },
  localDot: { width: 7, height: 7, borderRadius: '50%', backgroundColor: syntax.string },
  offlineDot: { backgroundColor: colors.muted },
  pendingDot: { backgroundColor: colors.warningText },
  localLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    gap: 6,
    height: 30,
    padding: '0 10px',
    color: colors.secondary,
    fontSize: type.small,
  },
});
