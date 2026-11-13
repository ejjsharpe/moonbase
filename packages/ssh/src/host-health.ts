import { hostTokenPattern } from '@moonbase/contracts/host';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Effect } from 'effect';
import { ApplicationError, fail } from '@moonbase/contracts/errors';
import type { ChatHostHealth, ChatHostTarget, HostHealthReply } from '@moonbase/contracts/host';
import type { ChatHostEndpoint } from '@moonbase/contracts/services';
import { normalizeApplicationError, releaseResource } from '@moonbase/effect';
import { decodeChatHostHealth } from '@moonbase/contracts/host-schema';

export type { ChatHostEndpoint } from '@moonbase/contracts/services';
export type { HostHealthReply } from '@moonbase/contracts/host';
const maximumHealthBytes = 8 * 1024;
/** The HMAC domain for signed health proofs. */
export const healthDomain = 'moonbase-daemon-health-v1';
const identity = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value);
const nonceValid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z0-9_-]{43}$/.test(value) &&
  Buffer.from(value, 'base64url').toString('base64url') === value;
function configuredToken(value: string) {
  if (typeof value !== 'string' || !hostTokenPattern.test(value))
    fail('InvalidInput', 'Configure a valid host key outside the renderer.');
}
function signature(
  token: string,
  phase: 'request' | 'response',
  nonce: string,
  health?: ChatHostHealth,
) {
  const fields = health
    ? [health.protocol, health.hostId, health.storeId, health.version, health.capabilities]
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

/** Server-side health handler: authenticate the client and prove the configured host identity. */
export function createHostHealthReply(input: {
  token: string;
  nonce: string | undefined;
  authorization: string | undefined;
  health: ChatHostHealth;
}): HostHealthReply {
  configuredToken(input.token);
  const requestProof = input.authorization?.match(/^Moonbase-HMAC-SHA256 ([a-f0-9]{64})$/)?.[1];
  if (
    !nonceValid(input.nonce) ||
    !matchesProof(requestProof, signature(input.token, 'request', input.nonce))
  )
    return fail('Unauthorized', 'Chat host rejected health authentication.');
  const health = validateHostHealth(input.health, input.health);
  return {
    ...health,
    nonce: input.nonce,
    proof: signature(input.token, 'response', input.nonce, health),
  };
}

function endpointOrigin(endpoint: ChatHostEndpoint): string {
  let url: URL;
  try {
    url = new URL(endpoint.origin);
  } catch {
    return fail('InvalidInput', 'Choose an explicit loopback chat endpoint.');
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
    return fail(
      'InvalidInput',
      'Chat endpoints must be plain 127.0.0.1 origins without credentials, paths or queries.',
    );
  if (!identity(endpoint.expected?.hostId) || !identity(endpoint.expected?.storeId))
    return fail('InvalidInput', 'Configure the expected chat host and store identities.');
  configuredToken(endpoint.token);
  return url.origin;
}

export function validateHostHealth(value: unknown, expected: ChatHostTarget): ChatHostHealth {
  if (!value || typeof value !== 'object')
    return fail('Incompatible', 'Chat host returned invalid health data.');
  const data = value as Record<string, unknown>;
  if (
    !identity(data.hostId) ||
    !identity(data.storeId) ||
    data.hostId !== expected.hostId ||
    data.storeId !== expected.storeId
  )
    return fail(
      'Incompatible',
      'Chat host or store identity does not match the configured target.',
    );
  return decodeChatHostHealth(value);
}

/** Verification is an Effect in the caller's existing process scope, never a runtime. */
export const checkHostHealth = (
  endpoint: ChatHostEndpoint,
): Effect.Effect<ChatHostHealth, ApplicationError> =>
  Effect.flatMap(
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
      catch: normalizeApplicationError,
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
              signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
            }),
          catch: () =>
            new ApplicationError({
              code: 'Unavailable',
              message: 'Chat host health could not be reached within its deadline.',
            }),
        }),
        (response) =>
          Effect.acquireUseRelease(
            Effect.sync(() => response.body?.getReader()),
            (reader) =>
              Effect.tryPromise({
                try: async () => {
                  if (response.status === 401 || response.status === 403)
                    return fail('Unauthorized', 'Chat host rejected authentication.');
                  if (!response.ok)
                    return fail(
                      'Incompatible',
                      'Chat host health returned an unsuccessful status.',
                    );
                  if (
                    !/^application\/json(?:\s*;|$)/i.test(
                      response.headers.get('content-type') ?? '',
                    )
                  )
                    return fail('Incompatible', 'Chat host health must be JSON.');
                  if (!reader) return fail('Incompatible', 'Chat host returned empty health data.');
                  const chunks: Uint8Array[] = [];
                  let length = 0;
                  while (true) {
                    const part = await reader.read();
                    if (part.done) break;
                    length += part.value.byteLength;
                    if (length > maximumHealthBytes)
                      return fail('Incompatible', 'Chat host health exceeds its size limit.');
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
                    return fail('Incompatible', 'Chat host returned malformed health JSON.');
                  }
                  const health = validateHostHealth(value, endpoint.expected),
                    reply = value as Record<string, unknown>;
                  if (
                    reply.nonce !== nonce ||
                    !matchesProof(reply.proof, signature(endpoint.token, 'response', nonce, health))
                  )
                    return fail(
                      'Unauthorized',
                      'Chat host did not prove the configured health identity.',
                    );
                  return health;
                },
                catch: (error) =>
                  ApplicationError.is(error)
                    ? error
                    : new ApplicationError({
                        code: 'Unavailable',
                        message: 'Chat host health could not be read.',
                      }),
              }),
            (reader) =>
              releaseResource(async () => {
                try {
                  await reader?.cancel();
                } finally {
                  reader?.releaseLock();
                }
              }),
          ),
      ),
  );
