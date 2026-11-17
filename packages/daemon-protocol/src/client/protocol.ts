/** Bounds a chat or daemon request: the client's wait for its reply. */
export const requestDeadlineMs = 20000;

/** How a watch reconnects after its connection drops. */
export const streamLimits = {
  // A value this long after a connection's first one proves it healthy and renews its reconnect
  // budget.
  renewMs: 5000,
  reconnectMs: [250, 500, 1000],
} as const;
