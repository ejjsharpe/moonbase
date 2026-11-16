import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { checkoutKey, type EditorController } from '@moonbase/application/editor';

/** A files tree's open context menu: for `paths`, opened on the row `path` at `point`. */
export type TreeMenu = {
  checkout: CheckoutTarget;
  paths: string[];
  path: string;
  point: DOMRect;
  /** The tree's scroll as the menu opened; scrolling away closes it. */
  scroll: number;
};

/**
 * A files tree's context menu. It shows only while the tree is visible, its row is shown and no
 * dialog is open (`available`), closes when a dialog takes focus or the tree scrolls, and returns
 * focus to the tree as it closes unless focus went elsewhere.
 */
export function useTreeMenu({
  controller,
  checkout,
  treeElement,
  setAnchor,
  selection,
  editPath,
  shown,
  returnTreeFocus,
  visible,
  dialogOpen,
  disposed,
}: {
  controller: EditorController;
  checkout: CheckoutTarget;
  treeElement: RefObject<HTMLDivElement | null>;
  /** Sets the entry a Shift-selection extends from, or clears it. */
  setAnchor: (path: string | null) => void;
  selection: readonly string[];
  /** The row whose name is typed, which has no menu. */
  editPath: string | null;
  /** Whether a row is shown, so its menu can be. */
  shown: (path: string) => boolean;
  returnTreeFocus: () => HTMLElement | false;
  visible: boolean;
  dialogOpen: boolean;
  disposed: boolean;
}) {
  const [menu, setMenu] = useState<TreeMenu | null>(null),
    restoreFocus = useRef(true);
  useLayoutEffect(() => {
    if (dialogOpen) restoreFocus.current = false;
  }, [visible, dialogOpen]);
  const available =
    !!menu &&
    visible &&
    !dialogOpen &&
    !disposed &&
    checkoutKey(menu.checkout) === checkoutKey(checkout) &&
    shown(menu.path);
  useLayoutEffect(() => {
    const element = treeElement.current;
    if (!available || !element) return;
    const ownerDocument = element.ownerDocument;
    function dismissForDialog(event: FocusEvent) {
      if (!(event.target instanceof Element) || !event.target.closest('[role="dialog"]')) return;
      restoreFocus.current = false;
      setMenu(null);
    }
    ownerDocument.addEventListener('focusin', dismissForDialog);
    return () => ownerDocument.removeEventListener('focusin', dismissForDialog);
  }, [available, treeElement]);
  // A menu that can't show is gone, rather than back once it could.
  if (menu && !available) setMenu(null);
  return {
    menu,
    available,
    /** Where focus goes as the menu closes: back to the tree, unless it went elsewhere. */
    finalFocus: () => (restoreFocus.current ? returnTreeFocus() : false),
    /** Opens the menu for `path`, or the selection when it holds `path`, at a viewport point. */
    openMenu(path: string, x: number, y: number) {
      if (path === editPath) return;
      const selected = selection.includes(path);
      const paths = selected ? [...selection] : [path];
      if (!selected) setAnchor(path);
      restoreFocus.current = true;
      setMenu({
        checkout: { ...checkout },
        paths,
        path,
        point: DOMRect.fromRect({ x, y }),
        scroll: treeElement.current!.scrollTop,
      });
      controller.tree(checkout, { focus: path, selected: paths });
    },
    /** Closes the menu, returning focus to the tree or, with `restoreFocus` false, not. */
    closeMenu(options?: { restoreFocus: boolean }) {
      if (options) restoreFocus.current = options.restoreFocus;
      setMenu(null);
    },
    /** Closes the menu once the tree has scrolled from where it opened. */
    closeForScroll(top: number) {
      setMenu((current) => (current?.scroll === top ? current : null));
    },
  };
}

export type TreeMenuState = ReturnType<typeof useTreeMenu>;
