import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { checkoutKey, type EditorController } from '@moonbase/application/editor';
import { isTreeDragActive } from './use-entry-drag.ts';

/**
 * Per checkout key, the active file its tree last followed (or left alone while the user was in
 * it), or null when the next chance to follow should reveal it whatever it is.
 */
export type FollowedFiles = Map<string, string | null>;

/**
 * Follow Active File: reveals each newly `active` file in the tree while `follow` holds and the
 * tree is left alone (`busy` is false and focus is elsewhere), catching up on a file made active
 * while it couldn't follow. A checkout first seen in `followed` keeps its restored tree.
 */
export function useFollowActiveFile({
  controller,
  checkout,
  treeElement,
  setAnchor,
  mounted,
  follow,
  followed,
  active,
  dialogOpen,
  busy,
}: {
  controller: EditorController;
  checkout: CheckoutTarget;
  treeElement: RefObject<HTMLDivElement | null>;
  /** Sets the entry a Shift-selection extends from, or clears it. */
  setAnchor: (path: string | null) => void;
  mounted: RefObject<boolean>;
  follow: boolean;
  followed: FollowedFiles;
  active: string;
  dialogOpen: boolean;
  /** Whether the user is typing a name, in the tree's menu, or dragging over it. */
  busy: boolean;
}) {
  const checkoutIdentity = checkoutKey(checkout);
  // What can stop the tree following the active file, as of the latest render.
  const latest = useRef({ follow, active, dialogOpen, busy });
  useLayoutEffect(() => {
    latest.current = { follow, active, dialogOpen, busy };
  });
  useEffect(() => {
    // A checkout first seen keeps its restored tree; later, a file made active while the tree
    // couldn't follow (hidden, unmounted for Changes, or behind a dialog) is revealed once it can.
    if (!followed.has(checkoutIdentity)) followed.set(checkoutIdentity, active);
    const previous = followed.get(checkoutIdentity)!;
    if (!follow || dialogOpen || !active || previous === active) return;
    followed.set(checkoutIdentity, active);
    const path = active;
    // The tree follows only while shown and left alone: not while the user is in it, typing a
    // name, dragging, in its menu or a dialog, and only while `path` is still the active file.
    const canFollow = () => {
      const now = latest.current,
        element = treeElement.current;
      return (
        mounted.current &&
        now.follow &&
        now.active === path &&
        !now.dialogOpen &&
        !now.busy &&
        !isTreeDragActive() &&
        !!element &&
        !element.contains(element.ownerDocument.activeElement)
      );
    };
    // While the user is in the tree it stays where they left it, even once they leave.
    if (!canFollow()) return;
    let started = false;
    // Rapid switches settle on the last file before anything is listed for it.
    const timer = setTimeout(() => {
      started = true;
      if (!canFollow()) return;
      // Hidden ignored files stay hidden rather than turning Hide Ignored Files off, and a follow
      // the user didn't ask for reports nothing.
      controller
        .reveal({ checkout, path }, { ignored: 'skip', current: canFollow, quiet: true })
        .then(
          (revealed) => {
            if (revealed) setAnchor(null);
          },
          () => {
            // Following is best effort: a file that has gone simply isn't revealed.
          },
        );
    }, 50);
    return () => {
      clearTimeout(timer);
      // Stopped before it began, such as by hiding the tree, it is still to catch up on.
      if (!started && followed.get(checkoutIdentity) === path)
        followed.set(checkoutIdentity, previous);
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Follow each active file, catching up when following resumes.
  }, [active, follow, dialogOpen]);
}
