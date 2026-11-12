import { createHmac, timingSafeEqual } from 'node:crypto';
import { chatProtocolVersion, type ChatHostTarget } from '@moonbase/contracts/host';
import { socketDomain, socketLimits } from '@moonbase/contracts/socket';
import { fail } from './validation.ts';
import { json } from './protocol.ts';

export type SocketDirection = 'client' | 'server';
export type SocketKeys = Record<SocketDirection, Buffer>;
/** What the hello binds: the client's nonce, the server's challenge, the protocol and the host. */
export type SocketBinding = { nonce: string; challenge: string; host: ChatHostTarget };
export type SocketClock = {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};
export const systemSocketClock: SocketClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Each direction's frame key, derived from the token and everything the hello binds, so a frame
 * verifies only on its own connection and in its own direction.
 */
export function deriveSocketKeys(token: string, binding: SocketBinding): SocketKeys {
  const key = (direction: SocketDirection) =>
    createHmac('sha256', token)
      .update(
        JSON.stringify([
          socketDomain,
          'frame-key',
          direction,
          chatProtocolVersion,
          binding.host.hostId,
          binding.host.storeId,
          binding.nonce,
          binding.challenge,
        ]),
      )
      .digest();
  return { client: key('client'), server: key('server') };
}
const mac = (key: Buffer, body: Uint8Array) => createHmac('sha256', key).update(body).digest();
/** A message's bytes: the 32-byte HMAC of its JSON body, then the body. */
export function sealSocketMessage(key: Buffer, value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length + 32 > socketLimits.frameBytes)
    fail('InvalidInput', 'Socket message exceeds its frame limit.');
  return Buffer.concat([mac(key, body), body]);
}
/** The sealed message's body bytes, or undefined when it is too short to hold a MAC and body. */
export const readSealedBody = (bytes: Uint8Array) =>
  bytes.length > 32 ? bytes.subarray(32) : undefined;
/** Whether `bytes` carry a valid MAC under `key`; checked before its body is trusted. */
export function verifySocketMessage(key: Buffer, bytes: Uint8Array) {
  const body = readSealedBody(bytes);
  return !!body && timingSafeEqual(Buffer.from(bytes.subarray(0, 32)), mac(key, body));
}
/** The verified body's JSON; a bad MAC or body fails without saying which. */
export function openSocketMessage(key: Buffer, bytes: Uint8Array): unknown {
  if (!verifySocketMessage(key, bytes)) fail('Unauthorized', 'Socket message is not authentic.');
  return json(bytes.subarray(32));
}
type PayloadChunk = { offset: number; total: number; data: string };
/** A payload's JSON in `socketLimits.chunkBytes` chunks of base64, each made when asked for. */
export type PayloadChunks = {
  count: number;
  /** The payload's JSON length, held while it is written. */
  bytes: number;
  chunk(index: number): PayloadChunk;
};
/** `value`'s JSON as chunks, or undefined when it exceeds `limit` bytes. */
export function payloadChunks(
  value: unknown,
  limit: number = socketLimits.payloadBytes,
): PayloadChunks | undefined {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > limit) return undefined;
  return {
    count: Math.ceil(bytes.length / socketLimits.chunkBytes),
    bytes: bytes.length,
    chunk: (index) => {
      const offset = index * socketLimits.chunkBytes;
      return {
        offset,
        total: bytes.length,
        data: bytes.subarray(offset, offset + socketLimits.chunkBytes).toString('base64'),
      };
    },
  };
}
/** A payload's JSON in `socketLimits.chunkBytes` chunks of base64. */
export function chunkPayload(value: unknown, limit?: number) {
  const chunks = payloadChunks(value, limit);
  return chunks && Array.from({ length: chunks.count }, (_, index) => chunks.chunk(index));
}
/** Reassembles one chunked payload at a time; chunks must arrive in order and back to back. */
export class PayloadAssembler {
  private parts: Buffer[] = [];
  private received = 0;
  private key: string | undefined;
  private total = 0;
  /** Whether a payload is partly received. */
  get partial() {
    return this.key !== undefined;
  }
  /** The payload's JSON once `chunk` completes it; any gap, overlap or interleaving fails. */
  push(
    key: string,
    chunk: PayloadChunk,
    limit: number = socketLimits.payloadBytes,
  ): { value: unknown } | undefined {
    if (this.key === undefined) {
      if (chunk.offset !== 0 || chunk.total > limit)
        fail('Incompatible', 'Socket payload chunk is out of order or over its bound.');
      this.key = key;
      this.total = chunk.total;
    } else if (key !== this.key || chunk.total !== this.total || chunk.offset !== this.received)
      fail('Incompatible', 'Socket payload chunk is out of order.');
    const bytes = Buffer.from(chunk.data, 'base64');
    this.received += bytes.length;
    if (this.received > this.total) fail('Incompatible', 'Socket payload exceeds its total.');
    this.parts.push(bytes);
    if (this.received < this.total) return undefined;
    const whole = Buffer.concat(this.parts, this.total);
    this.parts = [];
    this.received = 0;
    this.key = undefined;
    return { value: json(whole) };
  }
}

/**
 * Reassembles the chunked payloads of one connection's incoming replies and snapshots, which the
 * daemon may interleave: each payload's chunks must still arrive in order, but those of other
 * payloads may fall between them. Payloads in flight together are bounded in count and bytes.
 */
export class PayloadReassembly {
  private readonly payloads = new Map<string, { assembler: PayloadAssembler; total: number }>();
  private held = 0;
  private readonly maxBytes = socketLimits.workspaceInFlightBytes;
  private readonly maxPayloads = socketLimits.requests + socketLimits.subscriptions;
  /** Whether a payload whose key starts with `prefix` is partly received. */
  partial(prefix: string) {
    for (const key of this.payloads.keys()) if (key.startsWith(prefix)) return true;
    return false;
  }
  /** The payload's JSON once `chunk` completes it; any gap, overlap or excess fails. */
  push(
    key: string,
    chunk: PayloadChunk,
    limit: number = socketLimits.payloadBytes,
  ): { value: unknown } | undefined {
    let payload = this.payloads.get(key);
    if (!payload) {
      if (
        chunk.offset !== 0 ||
        chunk.total > limit ||
        this.payloads.size >= this.maxPayloads ||
        this.held + chunk.total > this.maxBytes
      )
        fail('Incompatible', 'Socket payload chunk is out of order or over its bound.');
      payload = { assembler: new PayloadAssembler(), total: chunk.total };
      this.payloads.set(key, payload);
      this.held += chunk.total;
    }
    const done = payload.assembler.push(key, chunk, limit);
    if (done) {
      this.payloads.delete(key);
      this.held -= payload.total;
    }
    return done;
  }
}
