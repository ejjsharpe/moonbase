import type { ClipboardEvent, KeyboardEvent, RefObject } from 'react';
import type { CheckoutTarget, DirectoryListing } from '@moonbase/contracts/workspace';
import { checkoutKey } from '@moonbase/application/editor';
import { findCreateFolder } from '../files-tree/files-tree-rows.ts';
import type { useFileClipboard } from '../files-tree/file-clipboard.ts';
import type { ExplorerPanel } from './explorer.tsx';

/**
 * Pasting in the explorer: files copied in the OS import, through `selectClipboardImports`, or
 * else, in the Files view, the tree's cut or copied entries paste, and are then selected in the
 * tree, which takes focus unless the user moved it elsewhere meanwhile.
 */
export function useExplorerPaste({
  checkout,
  focus,
  panel,
  listings,
  fileClipboard,
  selectClipboardImports,
  importFiles,
  explorerElement,
  treeElement,
  onPasted,
  run,
}: {
  checkout: CheckoutTarget | undefined;
  /** The tree's focused entry. */
  focus: string | undefined;
  panel: ExplorerPanel;
  listings: Readonly<Record<string, DirectoryListing>>;
  fileClipboard: ReturnType<typeof useFileClipboard>;
  selectClipboardImports?: (checkout: CheckoutTarget) => Promise<string[] | null>;
  importFiles: (checkout: CheckoutTarget, references: string[]) => void;
  explorerElement: RefObject<HTMLElement | null>;
  treeElement: RefObject<HTMLElement | null>;
  /** Called once entries pasted from the tree's clipboard have landed. */
  onPasted: () => void;
  run: (work: Promise<unknown>) => void;
}) {
  /**
   * Pastes into a checkout's `folder`: files copied in the OS since, which import as before, or
   * else, with `tree`, the tree's cut or copied entries. A declined import pastes nothing.
   */
  function pasteInto(target: CheckoutTarget, folder: string, tree = true) {
    const captured = { ...target };
    const filesTree = () => treeElement.current ?? false;
    run(
      (async () => {
        if (selectClipboardImports) {
          const references = await selectClipboardImports(captured);
          if (references === null) return;
          if (references.length) {
            importFiles(captured, references);
            return;
          }
        }
        if (!tree) return;
        const landed = await fileClipboard.paste(captured, folder, filesTree);
        if (!landed.length) return;
        onPasted();
        // Focus the user moved elsewhere meanwhile stays there.
        const focused = document.activeElement;
        if (!focused || focused === document.body || explorerElement.current?.contains(focused)) {
          const tree = filesTree();
          if (tree) tree.focus();
        }
      })(),
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
