import { useEffect, useLayoutEffect, useRef, type FocusEvent, type RefObject } from 'react';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { checkoutKey } from '@moonbase/application/editor';
import type { EditorActions } from '../editor-actions.ts';

/** Whether an element that took focus can take it again. */
export const canRefocus = (element: Element | null): element is HTMLElement =>
  element instanceof HTMLElement &&
  element.isConnected &&
  element.getClientRects().length > 0 &&
  !element.matches(':disabled') &&
  !element.closest('[inert]');
export const isNameField = (target: EventTarget) =>
  target instanceof HTMLElement && target.tagName === 'INPUT';

/**
 * Where focus goes in a files tree: back to the tree when it can take it, and off a pressed row
 * once the press ends, since moving focus while a row is pressed would cancel a drag from it.
 */
export function useTreeFocus({
  actions,
  checkout,
  treeElement,
  visible,
}: {
  actions: EditorActions;
  checkout: CheckoutTarget;
  treeElement: RefObject<HTMLDivElement | null>;
  visible: boolean;
}) {
  const visibility = useRef(visible),
    // Whether the primary button is down on the tree, and how it's let go.
    pressing = useRef(false),
    releasePressRef = useRef(() => {});
  useLayoutEffect(() => {
    visibility.current = visible;
  }, [visible]);
  const checkoutIdentity = checkoutKey(checkout);
  /** The tree, when it is shown for an open checkout and can take focus back. */
  function returnTreeFocus() {
    const element = treeElement.current,
      snapshot = actions.getSnapshot(),
      recovery = snapshot.recovery;
    return visibility.current &&
      !snapshot.disposed &&
      element?.isConnected &&
      element.getClientRects().length &&
      recovery.openCheckoutIds.includes(checkout.checkoutId) &&
      recovery.checkouts.some((target) => checkoutKey(target) === checkoutIdentity)
      ? element
      : false;
  }
  /** Focuses the tree when it can take focus back. */
  function refocusTree() {
    const element = returnTreeFocus();
    if (element) element.focus();
  }
  /** Whether focus is still the tree's to place: in the tree, in a prompt, or nowhere. */
  function focusStayed() {
    const element = treeElement.current,
      focused = element?.ownerDocument.activeElement;
    return (
      !focused ||
      focused === element?.ownerDocument.body ||
      !!element?.contains(focused) ||
      !!focused.closest('[role="dialog"]')
    );
  }
  /** Ends a press on a row, returning focus the row took to the tree. */
  function releasePress() {
    pressing.current = false;
    const element = treeElement.current,
      focused = element?.ownerDocument.activeElement;
    if (element && focused !== element && focused?.getAttribute('role') === 'treeitem')
      if (element.contains(focused)) element.focus();
  }
  useLayoutEffect(() => {
    releasePressRef.current = releasePress;
  });
  useEffect(() => {
    const release = () => releasePressRef.current();
    window.addEventListener('pointerup', release, true);
    return () => window.removeEventListener('pointerup', release, true);
  }, []);
  return {
    returnTreeFocus,
    refocusTree,
    focusStayed,
    releasePress,
    onPointerDown(event: { button: number }) {
      if (event.button === 0) pressing.current = true;
    },
    /** Keeps focus on the tree itself, whose active descendant marks the focused row. */
    onFocus(event: FocusEvent<HTMLElement>) {
      // A row's name field keeps the focus, and its keys, while a name is typed.
      if (isNameField(event.target)) return;
      // Moving focus while a row is pressed would cancel a drag from it; the press's end
      // returns focus to the tree instead.
      if (pressing.current && event.target !== event.currentTarget) return;
      if (event.currentTarget.contains(event.target)) event.currentTarget.focus();
    },
  };
}

export type TreeFocus = ReturnType<typeof useTreeFocus>;
