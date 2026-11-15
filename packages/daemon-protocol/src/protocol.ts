import { randomBytes } from 'node:crypto';

/** Bounds a chat or daemon request: the client's wait for its reply. */
export const requestDeadlineMs = 20000;

/** 32 random bytes in canonical base64url. */
export const nonce = () => randomBytes(32).toString('base64url');
/** How a watch reconnects after its connection drops. */
export const streamLimits = {
  // A value this long after a connection's first one proves it healthy and renews its reconnect
  // budget.
  renewMs: 5000,
  reconnectMs: [250, 500, 1000],
} as const;
