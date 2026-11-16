import type { PickerEntry } from './go-to-rows.ts';

/** The editor's own commands the picker lists after `>`, for an open checkout. */
export function listEditorCommands({
  git,
  hasActiveFile,
  onShowEditor,
  showFiles,
  showChanges,
  revealActive,
  reopen,
  refresh,
}: {
  git: boolean;
  hasActiveFile: boolean;
  /** Brings the editor into view as a command runs. */
  onShowEditor?: () => void;
  showFiles: () => void;
  showChanges: () => void;
  revealActive: () => void;
  reopen: () => void;
  refresh: () => void;
}): PickerEntry[] {
  const command = (id: string, label: string, shortcut: string | undefined, run: () => void) => ({
    id,
    kind: 'command' as const,
    label,
    shortcut,
    run: () => {
      onShowEditor?.();
      run();
    },
  });
  return [
    command('show-files', 'Show Files', '⌘⇧E', showFiles),
    ...(git ? [command('show-changes', 'Show Changes', '⌘⇧G', showChanges)] : []),
    ...(hasActiveFile
      ? [command('reveal-active-file', 'Reveal Active File', undefined, revealActive)]
      : []),
    command('reopen-file', 'Reopen closed file', '⌘⇧T', reopen),
    command('refresh-files', 'Refresh files', undefined, refresh),
  ];
}
