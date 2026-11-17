import type { ConnectionSnapshot } from '@moonbase/contracts/connection';

/**
 * Whether `next` is a different connection from `previous` (another generation, or another
 * state), or a connected state while no link is open: either ends everything over the last link.
 */
export const isConnectionChanged = (
  previous: ConnectionSnapshot | null,
  next: ConnectionSnapshot,
  linkOpen: boolean,
) =>
  previous?.connectionId !== next.connectionId ||
  previous?.state !== next.state ||
  (next.state === 'connected' && !linkOpen);
