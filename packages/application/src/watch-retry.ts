/**
 * How a watch that failed as `Unavailable` (a restarted daemon, say) is watched again: after each
 * backoff in `retryMs`, whose length caps the attempts, with the count renewed only when the failed
 * watch had stayed up for `healthyMs`. The chat transcript and the editor's checkouts share it.
 */
export const watchRetry = {
  retryMs: [1000, 5000, 15000],
  healthyMs: 15000,
} as const;
