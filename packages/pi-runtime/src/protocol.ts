import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Effect } from 'effect';
import { releaseResource } from '@moonbase/effect';

import { ApplicationError } from '@moonbase/contracts/workspace';
export { maximumChatRequestBytes } from '@moonbase/contracts/chat';
import type { ChatHostEndpoint } from '@moonbase/contracts/services';
import { fail } from './validation.ts';

export const nonce = () => randomBytes(32).toString('base64url');
export const validNonce = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z0-9_-]{43}$/.test(value) &&
  Buffer.from(value, 'base64url').toString('base64url') === value;
export const hash = (body: Uint8Array | string) => createHash('sha256').update(body).digest('hex');
export const mac = (token: string, ...parts: unknown[]) =>
  createHmac('sha256', token)
    .update(JSON.stringify(['moonbase-chat-v1', ...parts]))
    .digest('hex');
export const proof = (value: unknown, expected: string) =>
  typeof value === 'string' &&
  /^[a-f0-9]{64}$/.test(value) &&
  timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(expected, 'hex'));
export const authorization = (value: unknown) =>
  typeof value === 'string'
    ? value.match(/^Moonbase-RPC-HMAC-SHA256 ([a-f0-9]{64})$/)?.[1]
    : undefined;
export function token(value: unknown): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{16,4096}$/.test(value))
    return fail('InvalidInput', 'Configure a private chat host key.');
  return value;
}
export function origin(endpoint: ChatHostEndpoint): string {
  token(endpoint.token);
  try {
    const url = new URL(endpoint.origin);
    if (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    )
      return url.origin;
  } catch {}
  return fail('InvalidInput', 'Chat transport requires an explicit 127.0.0.1 origin.');
}
export function json(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
  } catch {
    return fail('InvalidInput', 'Chat body must contain valid UTF-8 JSON.');
  }
}
export const codes = [
  'InvalidInput',
  'Unauthorized',
  'Incompatible',
  'Conflict',
  'Persistence',
  'Uncertain',
  'Unavailable',
  'Cancelled',
] as const;
export function publicError(error: unknown, operation?: string) {
  const code =
    ApplicationError.is(error) && codes.includes(error.code as (typeof codes)[number])
      ? error.code
      : 'Unavailable';
  const messages: Record<string, string> = {
    InvalidInput: 'Chat request is invalid or differs from its original identity.',
    Unauthorized: 'Chat request is not authorized.',
    Incompatible: 'Chat authority or protocol is incompatible.',
    Conflict: 'Chat is busy; retain this request and retry explicitly.',
    Persistence: 'Chat storage is unavailable; preserve pending input.',
    Uncertain: 'Chat outcome is uncertain; query its original request.',
    Unavailable: 'Chat host is unavailable.',
    Cancelled: 'Chat wait was cancelled.',
  };
  return {
    code,
    message:
      code === 'Conflict' && operation === 'getChatTranscriptContent'
        ? 'Transcript source changed; reload the selected content.'
        : messages[code],
  };
}
export function responseBytes(
  response: Response,
  max: number,
  unavailableCode: 'Unavailable' | 'Uncertain' = 'Unavailable',
  unprovedMutation = false,
): Effect.Effect<Uint8Array, ApplicationError> {
  const reject = (code: 'Unauthorized' | 'Incompatible', message: string): never =>
    fail(
      unprovedMutation ? 'Uncertain' : code,
      unprovedMutation
        ? 'Chat mutation outcome could not be authenticated. Preserve its original request and query before retrying.'
        : message,
    );
  return Effect.acquireUseRelease(
    Effect.try({
      try: () => response.body?.getReader(),
      catch: () =>
        new ApplicationError({
          code: unavailableCode,
          message:
            unavailableCode === 'Uncertain'
              ? 'Chat response reader is unavailable; preserve the original request.'
              : 'Chat response reader is unavailable; retry the read.',
        }),
    }),
    (reader) =>
      Effect.tryPromise({
        try: async () => {
          if (response.status === 401 || response.status === 403)
            return reject(
              'Unauthorized',
              'Chat host rejected authentication; no signed result was accepted.',
            );
          if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''))
            return reject('Incompatible', 'Chat response must be JSON.');
          if (!reader) return reject('Incompatible', 'Chat response is empty.');
          const chunks: Uint8Array[] = [];
          let total = 0;
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            total += part.value.length;
            if (total > max)
              return reject('Incompatible', 'Chat response exceeds its delivery limit.');
            chunks.push(part.value);
          }
          return Buffer.concat(chunks, total);
        },
        catch: (error) =>
          ApplicationError.is(error)
            ? error
            : new ApplicationError({
                code: unavailableCode,
                message:
                  unavailableCode === 'Uncertain'
                    ? 'Chat response could not be read; preserve the original request.'
                    : 'Chat response could not be read; retry the read.',
              }),
      }),
    (reader) =>
      releaseResource(async () => {
        try {
          try {
            await reader?.cancel();
          } finally {
            reader?.releaseLock();
          }
        } catch {
          throw new ApplicationError({
            code: unavailableCode,
            message:
              unavailableCode === 'Uncertain'
                ? 'Chat response reader release failed; preserve the original request.'
                : 'Chat response reader release failed; retry the read.',
          });
        }
      }),
  );
}
