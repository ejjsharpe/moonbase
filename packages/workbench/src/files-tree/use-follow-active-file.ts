import { useEffect, type RefObject } from 'react';
import { Effect } from 'effect';
import * as Atom from 'effect/reactivity/Atom';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { checkoutKey } from '@moonbase/application/editor';
import { isTreeDragActive } from './use-entry-drag.ts';
import type { EditorActions } from '../editor-actions.ts';
import { useEditorTask } from '../use-editor-task.ts';

/**
 * Per checkout key, the active file its tree last followed (or left alone while the user was in
 * it), or null when the next chance to follow should reveal it whatever it is.
 */
export type FollowedFiles = Map<string, string | null>;

/**
 * Follow Active File: reveals each newly `active` file in the tree while `follow` holds and the
 * tree is left alone (`busy` is false and focus is elsewhere), catching up on a file made active
 * while it couldn't follow or was busy. A checkout first seen in `followed` keeps its restored tree.
 */
export function useFollowActiveFile({
  actions,
  checkout,
  treeElement,
  setAnchor,
  follow,
  followed,
  active,
  dialogOpen,
  busy,
}: {
  actions: EditorActions;
  checkout: CheckoutTarget;
  treeElement: RefObject<HTMLDivElement | null>;
  /** Sets the entry a Shift-selection extends from, or clears it. */
  setAnchor: (path: string | null) => void;
  follow: boolean;
  followed: FollowedFiles;
  active: string;
  dialogOpen: boolean;
  /** Whether the user is typing a name, in the tree's menu, or dragging over it. */
  busy: boolean;
}) {
  const checkoutIdentity = checkoutKey(checkout);
  // One follow at a time: a newer one, a change of what it depends on, or unmounting the tree
  // interrupts it.
  const run = useEditorTask(actions, { replace: true });
  useEffect(() => {
    run(Atom.Interrupt);
    // A checkout first seen keeps its restored tree; later, a file made active while the tree
    // couldn't follow (hidden, unmounted for Changes, behind a dialog, or busy, such as while a
    // name it committed is still being applied) is revealed once it can.
    if (!followed.has(checkoutIdentity)) followed.set(checkoutIdentity, active);
    const previous = followed.get(checkoutIdentity)!;
    if (!follow || dialogOpen || busy || !active || previous === active) return;
    followed.set(checkoutIdentity, active);
    const path = active;
    const element = treeElement.current;
    // The tree follows only while shown and left alone: not while the user is in it, typing a
    // name, dragging, in its menu or a dialog. Any of those changing interrupts the follow.
    const isLeftAlone = () =>
      !isTreeDragActive() && !!element && !element.contains(element.ownerDocument.activeElement);
    // While the user is in the tree it stays where they left it, even once they leave.
    if (!isLeftAlone()) return;
    /** Succeeds once the user enters the tree, which ends a follow under way. */
    const entered = Effect.callback<void>((resume) => {
      const enter = () => resume(Effect.void);
      element!.addEventListener('focusin', enter);
      return Effect.sync(() => element!.removeEventListener('focusin', enter));
    });
    let started = false;
    run(
      Effect.gen(function* () {
        // Rapid switches settle on the last file before anything is listed for it.
        yield* Effect.sleep('50 millis');
        started = true;
        if (!isLeftAlone()) return;
        // Hidden ignored files stay hidden rather than turning Hide Ignored Files off, and a
        // follow the user didn't ask for reports nothing. Following is best effort: a file that
        // has gone simply isn't revealed.
        const revealed = yield* actions
          .reveal({ checkout, path }, { ignored: 'skip', quiet: true })
          .pipe(
            Effect.orElseSucceed(() => false),
            Effect.raceFirst(Effect.as(entered, false)),
          );
        if (revealed) setAnchor(null);
      }),
    );
    return () => {
      // Stopped before it began, such as by hiding the tree, it is still to catch up on.
      if (!started && followed.get(checkoutIdentity) === path)
        followed.set(checkoutIdentity, previous);
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Follow each active file, catching up when following resumes.
  }, [active, follow, dialogOpen, busy]);
}
