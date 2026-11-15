/** Where a daemon that advertises `rpc-v1` upgrades RPC connections for chat and the daemon. */
export const rpcPath = '/v3/rpc';
/** The first `Sec-WebSocket-Protocol` a client offers there, and the one the daemon accepts. */
export const rpcProtocol = 'moonbase.rpc.v3';
/** Where a daemon that advertises `workspace-v2` upgrades the workspace's own RPC connections. */
export const workspaceRpcPath = '/v3/workspace';
/** The first `Sec-WebSocket-Protocol` a workspace client offers, and the one the daemon accepts. */
export const workspaceRpcProtocol = 'moonbase.workspace.v3';
/**
 * The second offered protocol carries the upgrade's proof: `moonbase.proof.<nonce>.<hmac>`, the
 * nonce signed health issued and an HMAC-SHA256 under the host key over `rpcUpgradeDomain`, the
 * nonce, the host and the first offered protocol, so a proof opens only the socket it was made for.
 */
export const rpcProofPrefix = 'moonbase.proof.';
export const rpcUpgradeDomain = 'moonbase-daemon-rpc-upgrade-v1';
/** Bounds of the RPC transport, shared by both sockets unless `workspaceRpcLimits` says otherwise. */
export const rpcLimits = {
  /** Upgrade nonces outstanding at once, for either socket; a new one evicts the oldest. */
  upgradeNonces: 64,
  /** How long an upgrade nonce stays usable. */
  upgradeNonceMs: 30_000,
  /** RPC connections open at once. */
  connections: 32,
  /** Requests a connection runs at once, apart from its watches. */
  requests: 32,
  /** Watches a connection holds open. */
  watches: 64,
  /** The largest message a daemon accepts on an RPC connection. */
  messageBytes: 256 * 1024,
  /** The largest message a client accepts from a daemon (D11). */
  inboundBytes: 1024 * 1024,
  /** A connection that sends nothing for this long is closed; clients ping every 5 s. */
  idleMs: 30_000,
  /** Bytes a connection's socket may buffer before the daemon waits to write more. */
  outboundBytes: 1024 * 1024,
  /**
   * The client's bound on connecting: signed health, TCP, an SSH forward's channel and the
   * upgrade.
   */
  connectMs: 20_000,
} as const;
/**
 * Bounds of the workspace's RPC socket. A request's or reply's JSON is at most `payloadBytes`,
 * and its message at most `messageBytes` with the RPC envelope around it, in either direction.
 */
export const workspaceRpcLimits = {
  /** Workspace connections open at once, apart from the RPC ones. */
  connections: 32,
  /** Requests a connection runs at once, apart from its status calls and watches. */
  requests: 32,
  /** Further places only `saveStatus` and `operationStatus` use, so held requests cannot block them. */
  statusRequests: 2,
  /** Watches a connection holds open. */
  watches: 64,
  payloadBytes: 16 * 1024 * 1024,
  messageBytes: 16 * 1024 * 1024 + 64 * 1024,
  /**
   * Request input a connection's running requests hold at once; one that would pass it is refused
   * `HostUnavailableError` (`busy`) before it runs.
   */
  inFlightBytes: 32 * 1024 * 1024,
  /**
   * How long a client waits for any message before it drops the connection: long enough for a
   * reply of `payloadBytes` over a slow SSH forward, since a large reply delays the pong behind it.
   */
  pingTimeoutMs: 30_000,
} as const;
