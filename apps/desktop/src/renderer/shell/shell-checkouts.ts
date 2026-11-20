import type { EditorRecovery } from '@moonbase/application/editor';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';

/** Whether a checkout is its repository's main worktree. */
export const isMainCheckout = (checkout: CheckoutTarget) =>
  checkout.vcs === 'git' && checkout.worktree === 'main';

/**
 * The window's checkouts from the editor's recovery: the open ones in rail order, the selected
 * one, every one as a folder a new local chat may start in (the editor approved each), and the
 * closed projects to reopen, newest first.
 */
export function readShellCheckouts(
  recovery:
    | Pick<EditorRecovery, 'checkouts' | 'openCheckoutIds' | 'selectedCheckoutId'>
    | undefined,
) {
  const open =
    recovery?.openCheckoutIds
      .map((id) => recovery.checkouts.find((checkout) => checkout.checkoutId === id))
      .filter((checkout) => checkout !== undefined) ?? [];
  const folderProjects = (recovery?.checkouts ?? []).map((checkout) => ({
    root: checkout.root,
    projectId: checkout.projectId,
    ...(checkout.vcs === 'git' ? { branch: checkout.branch, worktree: checkout.worktree } : {}),
    open: !!recovery?.openCheckoutIds.includes(checkout.checkoutId),
  }));
  // One per repository whose projects are all closed, its main worktree when the editor knows it.
  const recent: CheckoutTarget[] = [];
  for (const checkout of [...(recovery?.checkouts ?? [])].reverse()) {
    const sameProject = (other: CheckoutTarget) =>
      other.hostId === checkout.hostId && other.projectId === checkout.projectId;
    if (open.some(sameProject)) continue;
    const listed = recent.findIndex(sameProject);
    if (listed < 0) recent.push(checkout);
    else if (isMainCheckout(checkout) && !isMainCheckout(recent[listed]!))
      recent[listed] = checkout;
  }
  const selected = open.find((checkout) => checkout.checkoutId === recovery?.selectedCheckoutId);
  return { open, selected, folderProjects, recent };
}
