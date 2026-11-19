import type { ClipboardEvent, KeyboardEvent, RefObject } from 'react';
import { Effect } from 'effect';
import type { CheckoutTarget, DirectoryListing } from '@moonbase/contracts/workspace';
import { checkoutKey } from '@moonbase/application/editor';
import { findCreateFolder } from '../files-tree/files-tree-rows.ts';
import type { useFileClipboard } from '../files-tree/use-file-clipboard.ts';
import type { ExplorerPanel } from './explorer.tsx';
import type { EditorActions } from '../editor-actions.ts';
import { useEditorTask } from '../use-editor-task.ts';

/**
 * Pasting in the explorer: files copied in the OS import, through the platform's
 * `selectClipboardImports`, or else, in the Files view, the tree's cut or copied entries paste, and are then selected in the
 * tree, which takes focus unless the user moved it elsewhere meanwhile.
 */
export function useExplorerPaste({
  actions,
  checkout,
  focus,
  panel,
  listings,
  fileClipboard,
  importFiles,
  explorerElement,
  treeElement,
  onPasted,
}: {
  actions: EditorActions;
  checkout: CheckoutTarget | undefined;
  /** The tree's focused entry. */
  focus: string | undefined;
  panel: ExplorerPanel;
  listings: Readonly<Record<string, DirectoryListing>>;
  fileClipboard: ReturnType<typeof useFileClipboard>;
  importFiles: (checkout: CheckoutTarget, references: string[]) => void;
  explorerElement: RefObject<HTMLElement | null>;
  treeElement: RefObject<HTMLElement | null>;
  /** Called once entries pasted from the tree's clipboard have landed. */
  onPasted: () => void;
}) {
  const run = useEditorTask(actions);
  const { selectClipboardImports } = actions.platform;
  /**
   * Pastes into a checkout's `folder`: files copied in the OS since, which import as before, or
   * else, with `tree`, the tree's cut or copied entries. A declined import pastes nothing.
   */
  function pasteInto(target: CheckoutTarget, folder: string, tree = true) {
    const captured = { ...target };
    const filesTree = () => treeElement.current ?? false;
    run(
      Effect.gen(function* () {
        if (selectClipboardImports) {
          const references = yield* selectClipboardImports(captured);
          if (references === null) return;
          if (references.length) {
            importFiles(captured, references);
            return;
          }
        }
        if (!tree) return;
        const landed = yield* fileClipboard.paste(captured, folder, filesTree);
        if (!landed.length) return;
        onPasted();
        // Focus the user moved elsewhere meanwhile stays there; the menu Paste was chosen from
        // may still be closing.
        const focused = document.activeElement;
        if (
          !focused ||
          focused === document.body ||
          explorerElement.current?.contains(focused) ||
          focused.closest('[role="menu"]')
        ) {
          const tree = filesTree();
          if (tree) tree.focus();
        }
      }),
    );
  }
  /**
   * ⌘V in the explorer: imports files copied in the OS or, in the Files view, pastes into the
   * tree's focused folder, or the focused file's folder.
   */
  function pasteFiles(event: ClipboardEvent | KeyboardEvent) {
    const tree = panel === 'files';
    const element = event.target as HTMLElement;
    if (
      !checkout ||
      focus === undefined ||
      (!selectClipboardImports && !(tree && fileClipboard.clipboard)) ||
      !event.currentTarget.contains(element) ||
      element.closest('[role="menu"], [role="dialog"]') ||
      element.closest('input,textarea,select,[contenteditable=true]')
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    pasteInto(checkout, findCreateFolder(listings, checkoutKey(checkout), focus), tree);
  }
  return { pasteInto, pasteFiles };
}
