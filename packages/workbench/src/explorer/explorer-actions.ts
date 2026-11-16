import type { RefObject } from 'react';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { readOwn, type EditorController, type MutationAction } from '@moonbase/application/editor';
import type { FollowedFiles } from '../files-tree/use-follow-active-file.ts';
import type { useMoveUndo } from '../files-tree/move-undo.ts';
import { formatKeys } from '../shortcuts.ts';
import type { ExplorerAction } from './explorer-menu.tsx';

/** What the explorer's "…" menu acts on and through. */
export type ExplorerActionContext = {
  controller: EditorController;
  checkout: CheckoutTarget;
  preserving: boolean;
  /** Whether a file is active, to reveal. */
  hasActiveFile: boolean;
  hideIgnoredFiles: boolean;
  following: boolean;
  /** What each checkout's tree last followed; turning Follow Active File on forgets it. */
  followed: FollowedFiles;
  moveUndo: ReturnType<typeof useMoveUndo>;
  canRequestMutation: (action: MutationAction) => boolean;
  /** Types a new entry's name in the tree. */
  requestCreate: (kind: 'create-file' | 'create-directory') => void;
  selectNativeImports?: (checkout: CheckoutTarget) => Promise<string[]>;
  importFiles: (checkout: CheckoutTarget, references: string[]) => void;
  revealActive: () => void;
  openGoTo: () => void;
  /** Where an undo's replace prompt returns focus: the "…" button. */
  menuButton: RefObject<HTMLElement | null>;
  run: (work: Promise<unknown>) => void;
};

/**
 * The explorer's "…" menu: New File/Folder, Import Files (with `selectNativeImports`), Undo Move,
 * Collapse All Folders, Reveal Active File, the Follow Active File and Hide Ignored Files
 * settings, Go to File and Refresh.
 */
export function listExplorerActions({
  controller,
  checkout,
  preserving,
  hasActiveFile,
  hideIgnoredFiles,
  following,
  followed,
  moveUndo,
  canRequestMutation,
  requestCreate,
  selectNativeImports,
  importFiles,
  revealActive,
  openGoTo,
  menuButton,
  run,
}: ExplorerActionContext): ExplorerAction[] {
  const undoLabel = moveUndo.labelFor(checkout);
  return [
    {
      label: 'New File…',
      icon: 'newFile',
      disabled: !canRequestMutation({ checkout, kind: 'create-file', paths: [] }),
      movesFocus: true,
      run: () => requestCreate('create-file'),
    },
    {
      label: 'New Folder…',
      icon: 'newFolder',
      disabled: !canRequestMutation({ checkout, kind: 'create-directory', paths: [] }),
      movesFocus: true,
      run: () => requestCreate('create-directory'),
    },
    ...(selectNativeImports
      ? [
          {
            label: 'Import Files…',
            icon: 'import',
            disabled: preserving,
            run: () =>
              run(
                (async () => {
                  const target = { ...checkout };
                  importFiles(target, await selectNativeImports(target));
                })(),
              ),
          } satisfies ExplorerAction,
        ]
      : []),
    {
      label: undoLabel ?? 'Undo Move',
      icon: 'undo',
      keys: formatKeys('Meta+Z'),
      disabled:
        !undoLabel ||
        !canRequestMutation({ checkout, kind: 'move', paths: moveUndo.movedPaths(checkout) }),
      run: () => void moveUndo.undo(checkout, () => menuButton.current ?? false),
    },
    'separator',
    {
      label: 'Collapse All Folders',
      icon: 'collapseAll',
      run: () => controller.tree(checkout, { expanded: [] }),
    },
    { label: 'Reveal Active File', icon: 'reveal', disabled: !hasActiveFile, run: revealActive },
    {
      label: 'Follow Active File',
      icon: 'follow',
      checked: following,
      run: () => {
        const follow = !(controller.getSnapshot().recovery.followActiveFile ?? true);
        // Turning it on reveals each checkout's active file, followed or not.
        if (follow) for (const key of followed.keys()) followed.set(key, null);
        controller.setFollowActiveFile(follow);
      },
    },
    {
      label: 'Hide Ignored Files',
      icon: 'filter',
      checked: hideIgnoredFiles,
      run: () =>
        controller.tree(checkout, {
          hideIgnoredFiles: !readOwn(controller.getSnapshot().recovery.views, checkout.checkoutId)
            ?.tree.hideIgnoredFiles,
        }),
    },
    'separator',
    { label: 'Go to File…', icon: 'search', keys: '⌘P', run: openGoTo },
    { label: 'Refresh', icon: 'refresh', run: () => run(controller.refresh(checkout)) },
  ];
}
