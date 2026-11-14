/** Where a daemon that advertises `rpc-v1` upgrades RPC connections. */
export const rpcPath = '/v3/rpc';
/** The first `Sec-WebSocket-Protocol` a client offers, and the one the daemon accepts. */
export const rpcProtocol = 'moonbase.rpc.v3';
/**
 * The second offered protocol carries the upgrade's proof: `moonbase.proof.<nonce>.<hmac>`, the
 * nonce signed health issued and an HMAC-SHA256 under the host key over `rpcUpgradeDomain`, the
 * nonce, the host and `rpcProtocol`.
 */
export const rpcProofPrefix = 'moonbase.proof.';
export const rpcUpgradeDomain = 'moonbase-daemon-rpc-upgrade-v1';
/** Bounds of the RPC transport. */
export const rpcLimits = {
  /** Upgrade nonces outstanding at once; a new one evicts the oldest. */
  upgradeNonces: 64,
  /** How long an upgrade nonce stays usable. */
  upgradeNonceMs: 30_000,
  /** RPC connections open at once. */
  connections: 32,
  /** Requests a connection runs at once, apart from its watches. */
  requests: 32,
  /** Watches a connection holds open. */
  watches: 64,
  /** The largest message a client accepts from a daemon (D11). */
  inboundBytes: 1024 * 1024,
  /** A connection that sends nothing for this long is closed; clients ping every 5 s. */
  idleMs: 30_000,
} as const;
