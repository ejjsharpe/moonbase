import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ChatHostTarget } from '@moonbase/contracts/host';
import { rpcLimits, rpcProofPrefix, rpcUpgradeDomain } from '@moonbase/contracts/rpc-upgrade';

/** 32 random bytes in canonical base64url. */
const isNonce = (value: string) =>
  /^[A-Za-z0-9_-]{43}$/.test(value) &&
  Buffer.from(value, 'base64url').toString('base64url') === value;
const proofOf = (token: string, nonce: string, host: ChatHostTarget, protocol: string) =>
  createHmac('sha256', token)
    .update(JSON.stringify([rpcUpgradeDomain, nonce, host.hostId, host.storeId, protocol]))
    .digest('hex');

/**
 * The protocols a client offers to upgrade to `protocol` (`rpcProtocol` or
 * `workspaceRpcProtocol`) with `nonce`, bound to the token, the host and that protocol.
 */
export const upgradeProtocols = (
  token: string,
  nonce: string,
  host: ChatHostTarget,
  protocol: string,
) => [protocol, `${rpcProofPrefix}${nonce}.${proofOf(token, nonce, host, protocol)}`];

/** What an upgrade's `Sec-WebSocket-Protocol` offers, if it is `protocol` and a proof. */
export function readUpgradeProtocols(header: string | null, protocol: string) {
  const offered = header?.split(',').map((value) => value.trim()) ?? [];
  if (offered.length !== 2 || offered[0] !== protocol) return undefined;
  const match = offered[1]!.match(/^moonbase\.proof\.([A-Za-z0-9_-]{43})\.([a-f0-9]{64})$/);
  if (!match || !offered[1]!.startsWith(rpcProofPrefix) || !isNonce(match[1]!)) return undefined;
  return { nonce: match[1]!, proof: match[2]! };
}

/** Whether `proof` is this host's for `nonce` and `protocol`. */
export const isUpgradeProof = (
  token: string,
  host: ChatHostTarget,
  nonce: string,
  proof: string,
  protocol: string,
) =>
  timingSafeEqual(
    Buffer.from(proof, 'hex'),
    Buffer.from(proofOf(token, nonce, host, protocol), 'hex'),
  );

/**
 * Nonces signed health issued for RPC upgrades: each usable once, for `rpcLimits.upgradeNonceMs`,
 * with at most `rpcLimits.upgradeNonces` outstanding (a new one evicts the oldest). `now` reads the
 * server's `Clock`, synchronously, as Bun's request handlers need.
 */
export function createUpgradeNonces(now: () => number) {
  const issued = new Map<string, number>();
  return {
    issue() {
      const nonce = randomBytes(32).toString('base64url');
      issued.set(nonce, now() + rpcLimits.upgradeNonceMs);
      for (const oldest of issued.keys()) {
        if (issued.size <= rpcLimits.upgradeNonces) break;
        issued.delete(oldest);
      }
      return nonce;
    },
    /** Uses `nonce` up: true once, while it is unexpired. */
    consume(nonce: string) {
      const expiry = issued.get(nonce);
      issued.delete(nonce);
      return expiry !== undefined && now() < expiry;
    },
  };
}
