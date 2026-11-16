import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { checkoutKey, readOwn, type EditorController } from '@moonbase/application/editor';

/** Where a keyboard command started, and so where focus returns once the file it opens shows. */
export type FocusOrigin = 'editor' | 'strip' | 'tree';

/** Where an element that had focus sits: the files tree, the tab strip in `strip`, else the editor. */
export function findFocusOrigin(element: HTMLElement, strip: Element | null): FocusOrigin {
  if (element.closest('[role="tree"]')) return 'tree';
  if (strip?.contains(element)) return 'strip';
  return 'editor';
}

type FocusRequest = {
  checkout: CheckoutTarget;
  path: string;
  origin: FocusOrigin;
  from: Element | null;
  interaction: number;
};

/**
 * Returns focus to where a command started once the file it opened is active: the tree, the
 * active tab or the editor, found by `findTarget`, else `fallback`. Focus the user moved elsewhere
 * meanwhile, or newer input (a press, a key or a Tab from outside), cancels the return; a
 * return waits while `blocked`, as it is while a dialog is open.
 */
export function useFocusReturn({
  controller,
  root,
  checkout,
  active,
  blocked,
  findTarget,
  fallback,
}: {
  controller: EditorController;
  root: RefObject<HTMLElement | null>;
  checkout: CheckoutTarget | undefined;
  /** The checkout's active file. */
  active: string | undefined;
  blocked: boolean;
  findTarget: (origin: FocusOrigin) => HTMLElement | null | undefined;
  fallback: () => HTMLElement | null | undefined;
}) {
  const [request, setRequest] = useState<FocusRequest | null>(null);
  // Counts input since a command started; a return is for the input it started on.
  const interaction = useRef(0);
  const placeFocus = useEffectEvent((request: FocusRequest) => {
    const element = root.current,
      focused = document.activeElement;
    const focusMoved =
      focused !== null &&
      focused !== document.body &&
      focused !== request.from &&
      !element?.contains(focused);
    if (
      !focusMoved &&
      request.interaction === interaction.current &&
      element?.getClientRects().length &&
      checkout &&
      checkoutKey(checkout) === checkoutKey(request.checkout) &&
      active === request.path
    )
      (findTarget(request.origin) ?? fallback())?.focus();
  });
  useLayoutEffect(() => {
    if (!request || blocked) return;
    placeFocus(request);
    // oxlint-disable-next-line react/set-state-in-effect -- Consume this one-shot DOM focus request after the target has rendered.
    setRequest(null);
  }, [request, blocked]);
  /** Counts newer input, which cancels a pending return; a close prompt's answer doesn't count. */
  function captureInteraction() {
    if (!controller.getSnapshot().closePrompt) interaction.current++;
  }
  useEffect(() => {
    const document = root.current?.ownerDocument;
    const onExternalTab = (event: globalThis.KeyboardEvent) => {
      if (
        event.key === 'Tab' &&
        !root.current?.contains(event.target as Node) &&
        !controller.getSnapshot().closePrompt
      )
        interaction.current++;
    };
    document?.addEventListener('keydown', onExternalTab, true);
    return () => document?.removeEventListener('keydown', onExternalTab, true);
  }, [controller, root]);
  /**
   * Returns focus to `origin` once `opening` settles with the file open, or with `restore`
   * whatever its outcome.
   */
  function withFocus(opening: Promise<boolean>, origin: FocusOrigin, restore = false) {
    const from = document.activeElement;
    const started = interaction.current;
    const focus = () => {
      const next = controller.getSnapshot().recovery;
      if (checkout && next.openCheckoutIds.includes(checkout.checkoutId))
        setRequest({
          checkout,
          path: readOwn(next.views, checkout.checkoutId)!.active,
          origin,
          from,
          interaction: started,
        });
    };
    return opening.then(
      (success) => {
        if (success || restore) focus();
      },
      (error) => {
        if (restore) focus();
        throw error;
      },
    );
  }
  return {
    withFocus,
    captureInteraction,
    /** Where the pending return goes, if one is pending. */
    pendingOrigin: request?.origin,
  };
}

export type FocusReturn = ReturnType<typeof useFocusReturn>;
