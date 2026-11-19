import type { DirectoryListing, CheckoutTarget } from '@moonbase/contracts/workspace';
import { checkoutKey, type MutationAction } from '@moonbase/application/editor';
import type { Icon } from '@moonbase/ui/icons';
import { onMac } from '../shortcuts.ts';
import type { EditorActions } from '../editor-actions.ts';
import type { WorkbenchWork } from '../workbench-editor.ts';

/** What a name typed in the tree does. */
export type TreeEditKind = 'rename' | 'duplicate' | 'create-file' | 'create-directory';

/** The file operation each tree edit commits. */
export const editMutations = {
  rename: 'move',
  duplicate: 'copy',
  'create-file': 'create-file',
  'create-directory': 'create-directory',
} as const satisfies Record<TreeEditKind, MutationAction['kind']>;

export type FileCommand = {
  id: string;
  icon: Parameters<typeof Icon>[0]['name'];
  label: string;
  /** The shortcut with `Meta` for the platform's command key (⌘, or Ctrl off a Mac). */
  keys?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Whether focus returns to the tree after it runs. */
  staysInTree?: boolean;
  run(): void;
};
const revealLabel = onMac ? 'Reveal in Finder' : 'Show in Folder';

/** What file commands act on and how they reach the app. */
export type FileCommandContext = {
  actions: EditorActions;
  checkout: CheckoutTarget;
  listings: Readonly<Record<string, DirectoryListing>>;
  canRequestMutation: (action: MutationAction) => boolean;
  /** Opens a mutation's dialog: Move to Trash. */
  requestMutation: (action: MutationAction, finalFocus: () => HTMLElement | false) => void;
  /** Types a name in the tree: renaming or duplicating `path`, or creating in folder `path`. */
  startEdit: (kind: TreeEditKind, path: string) => void;
  /** Where focus goes after a mutation dialog closes. */
  returnTreeFocus: () => HTMLElement | false;
  /** Runs a command's work for as long as the tree shows. */
  run: (work: WorkbenchWork) => void;
  mentionInChat?: (checkout: CheckoutTarget, paths: string[]) => void;
  /** Puts entries on the workbench's file clipboard, to copy or move where they are pasted. */
  putOnClipboard: (paths: string[], mode: 'copy' | 'cut') => void;
  /** Whether the file clipboard has something to paste into `folder`. */
  canPasteInto: (folder: string) => boolean;
  /** Pastes into `folder`: files copied in the OS since, else the file clipboard. */
  pasteInto: (folder: string) => void;
};

/**
 * What the menu and its shortcuts offer for `paths`: a file, a folder, or several items. Paste
 * goes into `row`, the row the menu is for, or the folder of a file there.
 */
export function listFileCommands(
  {
    actions,
    checkout,
    listings,
    canRequestMutation,
    requestMutation,
    startEdit,
    returnTreeFocus,
    run,
    mentionInChat,
    putOnClipboard,
    canPasteInto,
    pasteInto,
  }: FileCommandContext,
  paths: string[],
  row = paths[0],
): (FileCommand | 'separator')[] {
  const { copyPaths, revealPath } = actions.platform;
  // Every listed folder of this checkout, including selected ones a collapse has since hidden.
  const listingKey = JSON.stringify([checkoutKey(checkout), '']).slice(0, -3);
  const directories = new Set(
    Object.entries(listings).flatMap(([key, listing]) =>
      key.startsWith(listingKey)
        ? (listing?.entries ?? []).filter((entry) => entry.directory).map((entry) => entry.path)
        : [],
    ),
  );
  const one = paths.length === 1 ? paths[0] : null,
    folder = one !== null && directories.has(one),
    files = paths.filter((path) => !directories.has(path)),
    count = paths.length,
    plural = count > 1 ? ` ${count} Items` : '',
    mutation = (kind: MutationAction['kind'], sources: string[]) => ({
      disabled: !canRequestMutation({ checkout, paths: sources, kind }),
      run: () => requestMutation({ checkout, paths: sources, kind }, returnTreeFocus),
    }),
    typeName = (kind: TreeEditKind, path: string) => {
      const sources = kind === 'rename' || kind === 'duplicate' ? [path] : [];
      return {
        disabled: !canRequestMutation({ checkout, paths: sources, kind: editMutations[kind] }),
        run: () => startEdit(kind, path),
      };
    };
  const open: FileCommand[] = [];
  if (one !== null && !folder)
    open.push({
      id: 'open',
      icon: 'file',
      label: 'Open',
      keys: 'Enter',
      // Like Enter in the tree, so the keyboard stays where it was.
      staysInTree: true,
      run: () => {
        run(actions.open({ checkout, path: one }, { view: 'file', intent: 'keep' }));
      },
    });
  if (folder)
    open.push(
      {
        id: 'new-file',
        icon: 'newFile',
        label: 'New File…',
        ...typeName('create-file', one),
      },
      {
        id: 'new-folder',
        icon: 'newFolder',
        label: 'New Folder…',
        ...typeName('create-directory', one),
      },
    );
  const chat: FileCommand[] =
    mentionInChat && files.length
      ? [
          {
            id: 'mention',
            icon: 'mention',
            label: files.length > 1 ? `Mention ${files.length} Files in Chat` : 'Mention in Chat',
            run: () => mentionInChat(checkout, files),
          },
        ]
      : [];
  const pasteFolder = directories.has(row) ? row : row.split('/').slice(0, -1).join('/');
  const clipboard: FileCommand[] = [
    {
      id: 'cut',
      icon: 'cut',
      label: 'Cut',
      keys: 'Meta+X',
      staysInTree: true,
      run: () => putOnClipboard(paths, 'cut'),
    },
    {
      id: 'copy',
      icon: 'copy',
      label: 'Copy',
      keys: 'Meta+C',
      staysInTree: true,
      run: () => putOnClipboard(paths, 'copy'),
    },
    {
      id: 'paste',
      icon: 'paste',
      label: 'Paste',
      keys: 'Meta+V',
      disabled: !canPasteInto(pasteFolder),
      staysInTree: true,
      run: () => pasteInto(pasteFolder),
    },
  ];
  const edit: FileCommand[] = [];
  if (one !== null) {
    edit.push({
      id: 'rename',
      icon: 'rename',
      label: 'Rename…',
      keys: 'F2',
      ...typeName('rename', one),
    });
    if (!folder)
      edit.push({
        id: 'duplicate',
        icon: 'copy',
        label: 'Duplicate…',
        ...typeName('duplicate', one),
      });
  }
  if (copyPaths)
    edit.push(
      {
        id: 'copy-path',
        icon: 'link',
        label: count > 1 ? 'Copy Paths' : 'Copy Path',
        keys: 'Alt+Meta+C',
        staysInTree: true,
        run: () => run(copyPaths(checkout, paths, false)),
      },
      {
        id: 'copy-relative-path',
        icon: 'link',
        label: count > 1 ? 'Copy Relative Paths' : 'Copy Relative Path',
        keys: 'Shift+Alt+Meta+C',
        staysInTree: true,
        run: () => run(copyPaths(checkout, paths, true)),
      },
    );
  if (revealPath && one !== null)
    edit.push({
      id: 'reveal',
      icon: 'finder',
      label: revealLabel,
      keys: 'Alt+Meta+R',
      staysInTree: true,
      run: () => run(revealPath(checkout, one)),
    });
  const trash: FileCommand = {
    id: 'trash',
    icon: 'trash',
    label: `Move${plural} to Trash`,
    keys: 'Meta+Backspace',
    danger: true,
    ...mutation('trash', paths),
  };
  return [open, chat, clipboard, edit, [trash]]
    .filter((group) => group.length)
    .flatMap((group, index) => (index ? ['separator' as const, ...group] : group));
}
