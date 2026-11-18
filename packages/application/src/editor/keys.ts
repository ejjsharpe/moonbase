import type { CheckoutTarget, FileTarget } from '@moonbase/contracts/workspace';

// The keys the editor files its checkouts and files under: an exact target, never a bare path.

export const checkoutKey = (target: CheckoutTarget) =>
  JSON.stringify([
    target.hostId,
    target.checkoutId,
    target.projectId,
    target.root,
    target.vcs,
    ...(target.vcs === 'git' ? [target.branch, target.worktree] : []),
  ]);
export const fileKey = (target: FileTarget) =>
  JSON.stringify([checkoutKey(target.checkout), target.path]);
export const sameCheckout = (a: CheckoutTarget, b: CheckoutTarget) =>
  checkoutKey(a) === checkoutKey(b);
