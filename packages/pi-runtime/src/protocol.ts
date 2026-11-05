import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Effect } from 'effect';
import { releaseResource } from '@moonbase/effect';

import { ApplicationError } from '@moonbase/contracts/workspace';
export { maximumChatRequestBytes, maximumChatReplyBytes } from '@moonbase/contracts/chat';
import { chatReplyErrorCodes } from '@moonbase/contracts/chat-schema';
import type { ChatHostEndpoint } from '@moonbase/contracts/services';
import { fail } from './validation.ts';

/** Bounds one RPC exchange: its challenge grant, request body read and whole client call. */
export const requestDeadlineMs = 20000;

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
export function publicError(error: unknown, operation?: string) {
  const code =
    ApplicationError.is(error) &&
    chatReplyErrorCodes.includes(error.code as (typeof chatReplyErrorCodes)[number])
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
  let readFailure: { error: unknown } | undefined;
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
            const part = await reader.read().catch((error) => {
              readFailure = { error };
              throw error;
            });
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
          } catch (error) {
            if (!readFailure || error !== readFailure.error) throw error;
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

// Stream proofs cannot be reflected into health/RPC or request proofs.
export const streamMac = (token: string, ...parts: unknown[]) =>
  createHmac('sha256', token)
    .update(JSON.stringify(['moonbase-chat-stream-v1', ...parts]))
    .digest('hex');
export const streamPath = '/v1/chat/watch';
export const streamLimits = {
  frameBytes: 256 * 1024,
  requestBytes: 4096,
  subscriptions: 64,
  establishmentMs: 20000,
  heartbeatMs: 10000,
  // A frame this long after a connection's first snapshot proves it healthy and renews its
  // reconnect budget; half a heartbeat interval tolerates timer skew around the first heartbeat.
  renewMs: 5000,
  idleMs: 30000,
  drainMs: 20000,
  reconnectMs: [250, 500, 1000],
} as const;
export function encodeFrame(token: string, nonce: string, challenge: string, value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length + 36 > streamLimits.frameBytes)
    fail('Incompatible', 'Chat stream frame exceeds its delivery limit.');
  const frame = Buffer.allocUnsafe(body.length + 36);
  frame.writeUInt32BE(body.length);
  body.copy(frame, 4);
  Buffer.from(streamMac(token, 'frame', nonce, challenge, hash(body)), 'hex').copy(
    frame,
    body.length + 4,
  );
  return frame;
}
/** Retains one bounded partial frame, including fragmented length/proof bytes. */
export class FrameDecoder {
  private buffer = Buffer.alloc(4);
  private used = 0;
  *push(bytes: Uint8Array): Generator<{ body: Uint8Array; proof: string }> {
    let offset = 0;
    while (offset < bytes.length) {
      const size = Math.min(this.buffer.length - this.used, bytes.length - offset);
      this.buffer.set(bytes.subarray(offset, offset + size), this.used);
      this.used += size;
      offset += size;
      if (this.used !== this.buffer.length) continue;
      if (this.buffer.length === 4) {
        const length = this.buffer.readUInt32BE();
        if (!length || length + 36 > streamLimits.frameBytes)
          fail('Incompatible', 'Chat stream frame exceeds its delivery limit.');
        const buffer = Buffer.allocUnsafe(length + 36);
        this.buffer.copy(buffer);
        this.buffer = buffer;
      } else {
        const frame = this.buffer;
        this.buffer = Buffer.alloc(4);
        this.used = 0;
        yield { body: frame.subarray(4, -32), proof: frame.subarray(-32).toString('hex') };
      }
    }
  }
  get partial() {
    return this.used !== 0;
  }
}
