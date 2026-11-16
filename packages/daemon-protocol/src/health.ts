import { hostTokenPattern } from '@moonbase/contracts/host';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Effect } from 'effect';
import {
  HostVerificationError,
  type HostVerificationReason,
} from '@moonbase/contracts/connection-errors';
import type { ChatHostHealth, ChatHostTarget, HostHealthReply } from '@moonbase/contracts/host';
import type { ChatHostEndpoint } from '@moonbase/contracts/services';
import { releaseResource } from '@moonbase/effect';
import { decodeChatHostHealth } from '@moonbase/contracts/host-schema';

export type { ChatHostEndpoint } from '@moonbase/contracts/services';
export type { HostHealthReply } from '@moonbase/contracts/host';
const refuse = (reason: HostVerificationReason): never => {
  throw new HostVerificationError({ reason });
};
const maximumHealthBytes = 8 * 1024;
/** How long one check may take, from its request until its body is read, on the caller's Clock. */
const healthDeadline = '5 seconds';
/** The HMAC domain for signed health proofs. */
export const healthDomain = 'moonbase-daemon-health-v1';
const identity = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value);
const nonceValid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z0-9_-]{43}$/.test(value) &&
  Buffer.from(value, 'base64url').toString('base64url') === value;
function configuredToken(value: string) {
  if (typeof value !== 'string' || !hostTokenPattern.test(value)) refuse('endpoint-key');
}
function signature(
  token: string,
  phase: 'request' | 'response',
  nonce: string,
  health?: ChatHostHealth,
  upgradeNonce?: string,
) {
  const fields = health
    ? [
        health.protocol,
        health.hostId,
        health.storeId,
        health.version,
        health.capabilities,
        ...(upgradeNonce === undefined ? [] : [upgradeNonce]),
      ]
    : [];
  return createHmac('sha256', token)
    .update(JSON.stringify([healthDomain, phase, nonce, ...fields]))
    .digest('hex');
}
function matchesProof(value: unknown, expected: string) {
  return (
    typeof value === 'string' &&
    /^[a-f0-9]{64}$/.test(value) &&
    timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(expected, 'hex'))
  );
}

/**
 * Server-side health handler: authenticate the client and prove the configured host identity.
 * `upgradeNonce`, which `issue` mints only once the client is authenticated, is signed into the
 * reply for the client's next RPC upgrade.
 */
export function createHostHealthReply(input: {
  token: string;
  nonce: string | undefined;
  authorization: string | undefined;
  health: ChatHostHealth;
  issue?: () => string;
}): HostHealthReply {
  configuredToken(input.token);
  const requestProof = input.authorization?.match(/^Moonbase-HMAC-SHA256 ([a-f0-9]{64})$/)?.[1];
  if (
    !nonceValid(input.nonce) ||
    !matchesProof(requestProof, signature(input.token, 'request', input.nonce))
  )
    return refuse('request-rejected');
  const upgradeNonce = input.issue?.();
  return {
    ...input.health,
    nonce: input.nonce,
    ...(upgradeNonce === undefined ? {} : { upgradeNonce }),
    proof: signature(input.token, 'response', input.nonce, input.health, upgradeNonce),
  };
}

function endpointOrigin(endpoint: ChatHostEndpoint): string {
  let url: URL;
  try {
    url = new URL(endpoint.origin);
  } catch {
    return refuse('endpoint');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    return refuse('endpoint-origin');
  if (!identity(endpoint.expected?.hostId) || !identity(endpoint.expected?.storeId))
    return refuse('endpoint-identity');
  configuredToken(endpoint.token);
  return url.origin;
}

export function validateHostHealth(value: unknown, expected: ChatHostTarget): ChatHostHealth {
  if (!value || typeof value !== 'object') return refuse('invalid');
  const data = value as Record<string, unknown>;
  if (
    !identity(data.hostId) ||
    !identity(data.storeId) ||
    data.hostId !== expected.hostId ||
    data.storeId !== expected.storeId
  )
    return refuse('identity');
  try {
    return decodeChatHostHealth(value);
  } catch {
    return refuse('invalid');
  }
}

/** Verification is an Effect in the caller's existing process scope, never a runtime. */
export const checkHostHealth = (
  endpoint: ChatHostEndpoint,
): Effect.Effect<ChatHostHealth, HostVerificationError> =>
  Effect.map(readSignedHealth(endpoint), ({ health }) => health);

/**
 * Checks health and returns the single-use nonce it signed for an RPC upgrade; a host that
 * signed none serves no RPC.
 */
export const requestUpgradeNonce = (
  endpoint: ChatHostEndpoint,
): Effect.Effect<{ health: ChatHostHealth; upgradeNonce: string }, HostVerificationError> =>
  Effect.flatMap(readSignedHealth(endpoint), ({ health, upgradeNonce }) =>
    upgradeNonce === undefined
      ? Effect.fail(new HostVerificationError({ reason: 'invalid' }))
      : Effect.succeed({ health, upgradeNonce }),
  );

const readSignedHealth = (
  endpoint: ChatHostEndpoint,
): Effect.Effect<{ health: ChatHostHealth; upgradeNonce?: string }, HostVerificationError> =>
  Effect.suspend(() => {
    // A deadline before the host answered is `unreachable`; one while its body stalls, `read-failed`.
    let answered = false;
    return Effect.flatMap(
      Effect.try({
        try: () => {
          const origin = endpointOrigin(endpoint),
            nonce = randomBytes(32).toString('base64url');
          return {
            origin,
            nonce,
            authorization: `Moonbase-HMAC-SHA256 ${signature(endpoint.token, 'request', nonce)}`,
          };
        },
        catch: (error) =>
          error instanceof HostVerificationError
            ? error
            : new HostVerificationError({ reason: 'endpoint' }),
      }),
      ({ origin, nonce, authorization }) =>
        Effect.flatMap(
          Effect.tryPromise({
            try: (signal) =>
              fetch(`${origin}/v1/health`, {
                headers: {
                  Authorization: authorization,
                  'X-Moonbase-Nonce': nonce,
                  Accept: 'application/json',
                },
                redirect: 'error',
                credentials: 'omit',
                cache: 'no-store',
                signal,
              }),
            catch: () => new HostVerificationError({ reason: 'unreachable' }),
          }),
          (response) => {
            answered = true;
            return Effect.acquireUseRelease(
              Effect.sync(() => response.body?.getReader()),
              (reader) =>
                Effect.tryPromise({
                  try: async () => {
                    if (response.status === 401 || response.status === 403)
                      return refuse('rejected');
                    if (!response.ok) return refuse('status');
                    if (
                      !/^application\/json(?:\s*;|$)/i.test(
                        response.headers.get('content-type') ?? '',
                      )
                    )
                      return refuse('not-json');
                    if (!reader) return refuse('empty');
                    const chunks: Uint8Array[] = [];
                    let length = 0;
                    while (true) {
                      const part = await reader.read();
                      if (part.done) break;
                      length += part.value.byteLength;
                      if (length > maximumHealthBytes) return refuse('too-large');
                      chunks.push(part.value);
                    }
                    const bytes = new Uint8Array(length);
                    let offset = 0;
                    for (const chunk of chunks) {
                      bytes.set(chunk, offset);
                      offset += chunk.byteLength;
                    }
                    let value: unknown;
                    try {
                      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
                    } catch {
                      return refuse('malformed');
                    }
                    const health = validateHostHealth(value, endpoint.expected),
                      reply = value as Record<string, unknown>,
                      upgradeNonce = reply.upgradeNonce;
                    if (upgradeNonce !== undefined && !nonceValid(upgradeNonce))
                      return refuse('invalid');
                    if (
                      reply.nonce !== nonce ||
                      !matchesProof(
                        reply.proof,
                        signature(endpoint.token, 'response', nonce, health, upgradeNonce),
                      )
                    )
                      return refuse('unproved');
                    return upgradeNonce === undefined ? { health } : { health, upgradeNonce };
                  },
                  catch: (error) =>
                    error instanceof HostVerificationError
                      ? error
                      : new HostVerificationError({ reason: 'read-failed' }),
                }),
              (reader) =>
                releaseResource(async () => {
                  try {
                    await reader?.cancel();
                  } finally {
                    reader?.releaseLock();
                  }
                }),
            );
          },
        ),
    ).pipe(
      Effect.timeoutOrElse({
        duration: healthDeadline,
        orElse: () =>
          Effect.fail(
            new HostVerificationError({
              reason: answered ? 'read-failed' : 'unreachable',
            }),
          ),
      }),
    );
  });
