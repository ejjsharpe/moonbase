import type { CheckoutTarget } from '@moonbase/contracts/workspace';

/** Whether `next` is the Git checkout that a plain-folder checkout became after `git init`. */
export const isInitialized = (previous: CheckoutTarget, next: CheckoutTarget) =>
  previous.vcs === 'none' &&
  next.vcs === 'git' &&
  previous.hostId === next.hostId &&
  previous.checkoutId === next.checkoutId &&
  previous.root === next.root;
