import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import type { EditorRecovery } from '../recovery/recovery-layout.ts';
import { sameCheckout, type ClosedAction } from '../recovery/recovery-references.ts';

/** The editor's tabs and views: its recovery layout, and the closes Reopen can undo. */
export type ViewsState = { recovery: EditorRecovery; closed: readonly ClosedAction[] };

/** Whether the checkout is one the editor knows, under this exact target. */
export const isCheckoutListed = (recovery: EditorRecovery, checkout: CheckoutTarget) =>
  recovery.checkouts.some((item) => sameCheckout(item, checkout));
/** Whether the checkout is open in the editor, under this exact target. */
export const isCheckoutOpen = (recovery: EditorRecovery, checkout: CheckoutTarget) =>
  recovery.openCheckoutIds.includes(checkout.checkoutId) && isCheckoutListed(recovery, checkout);

/** The closes Reopen remembers, newest last: at most 20. */
export const rememberClosed = (closed: readonly ClosedAction[], actions: ClosedAction[]) =>
  [...closed, ...actions].slice(-20);

/** The newest close in `checkout`, with its index, for Reopen. */
export function findClosedAction(closed: readonly ClosedAction[], checkout: CheckoutTarget) {
  const index = closed.findLastIndex((action) => sameCheckout(action.checkout, checkout));
  return index < 0 ? undefined : { index, action: structuredClone(closed[index]) };
}

/** Closes Reopen can no longer undo, for files moved to the Trash. */
export const forgetTrashed = (
  closed: readonly ClosedAction[],
  checkout: CheckoutTarget,
  source: string,
) =>
  closed.flatMap((action) => {
    if (!sameCheckout(action.checkout, checkout)) return [action];
    const files = action.files.filter(
      (file) => file.path !== source && !file.path.startsWith(source + '/'),
    );
    return files.length ? [{ ...action, files }] : [];
  });

/** Closes in a checkout that became another target (after `git init`) follow it. */
export const rebindClosed = (
  closed: readonly ClosedAction[],
  previous: CheckoutTarget,
  next: CheckoutTarget,
) =>
  closed.map((action) =>
    sameCheckout(action.checkout, previous) ? { ...action, checkout: next } : action,
  );

/** Closes of moved files follow the move. */
export function moveClosed(
  closed: readonly ClosedAction[],
  checkout: CheckoutTarget,
  source: string,
  destination: string,
) {
  const move = (path: string) =>
    path === source || path.startsWith(source + '/')
      ? destination + path.slice(source.length)
      : path;
  return closed.map((action) =>
    sameCheckout(action.checkout, checkout)
      ? {
          ...action,
          active: move(action.active),
          files: action.files.map((file) => ({ ...file, path: move(file.path) })),
        }
      : action,
  );
}
