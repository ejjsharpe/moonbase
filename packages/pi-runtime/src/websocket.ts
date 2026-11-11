import { createHash, randomBytes } from 'node:crypto';
import { fail } from './validation.ts';

/** RFC 6455 framing for the daemon's WebSocket: binary messages, pings and close, no extensions. */
export const webSocketOpcodes = {
  continuation: 0,
  text: 1,
  binary: 2,
  close: 8,
  ping: 9,
  pong: 10,
};
/** Close codes the daemon sends: going away on shutdown, policy violation for any refusal. */
export const webSocketCloseCodes = { normal: 1000, goingAway: 1001, policy: 1008 };

/** The `Sec-WebSocket-Accept` for a valid `Sec-WebSocket-Key`, or undefined for any other value. */
export function acceptWebSocketKey(key: unknown): string | undefined {
  if (
    typeof key !== 'string' ||
    !/^[A-Za-z0-9+/]{22}==$/.test(key) ||
    Buffer.from(key, 'base64').length !== 16
  )
    return undefined;
  return createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

/** One frame; a client masks what it sends and a server never does. */
export function encodeWebSocketFrame(opcode: number, payload: Uint8Array, masked = false) {
  const length = payload.length;
  let extended = 8,
    marker = 127;
  if (length < 126) [extended, marker] = [0, length];
  else if (length < 65536) [extended, marker] = [2, 126];
  const header = Buffer.alloc(2 + extended + (masked ? 4 : 0));
  header[0] = 0x80 | opcode;
  header[1] = (masked ? 0x80 : 0) | marker;
  if (extended === 2) header.writeUInt16BE(length, 2);
  else if (extended === 8) header.writeBigUInt64BE(BigInt(length), 2);
  if (!masked) return Buffer.concat([header, payload]);
  const mask = randomBytes(4);
  mask.copy(header, header.length - 4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i]! ^= mask[i & 3]!;
  return Buffer.concat([header, body]);
}
export const encodeWebSocketClose = (code: number, masked = false) => {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code);
  return encodeWebSocketFrame(webSocketOpcodes.close, payload, masked);
};

const violation = (): never => fail('InvalidInput', 'WebSocket framing is invalid.');
/**
 * Reassembles messages from received bytes, holding at most one message of `maximum` bytes and
 * one frame header. It refuses a message's length from its header, before buffering its payload.
 */
export class WebSocketReader {
  /** Received bytes not yet read as frames, and their length. */
  private chunks: Buffer[] = [];
  private buffered = 0;
  private message: Buffer[] = [];
  private messageBytes = 0;
  private messageOpcode: number | undefined;
  maximum: number;
  private readonly masked: boolean;
  /** `masked`: whether frames must be masked, as a server requires of a client. */
  constructor(maximum: number, masked: boolean) {
    this.maximum = maximum;
    this.masked = masked;
  }
  /** The first `length` buffered bytes, joined only when a frame spans received chunks. */
  private peek(length: number) {
    if (this.chunks[0]!.length < length) this.chunks = [Buffer.concat(this.chunks, this.buffered)];
    return this.chunks[0]!;
  }
  private consume(length: number) {
    this.buffered -= length;
    const rest = this.chunks[0]!.subarray(length);
    this.chunks = rest.length ? [rest, ...this.chunks.slice(1)] : this.chunks.slice(1);
  }
  *push(bytes: Uint8Array): Generator<{ opcode: number; payload: Buffer }> {
    if (bytes.length) {
      this.chunks.push(Buffer.from(bytes));
      this.buffered += bytes.length;
    }
    for (;;) {
      if (this.buffered < 2) return;
      let buffer = this.peek(2);
      const first = buffer[0]!,
        second = buffer[1]!,
        fin = (first & 0x80) !== 0,
        opcode = first & 0x0f,
        masked = (second & 0x80) !== 0;
      if (first & 0x70 || masked !== this.masked) violation();
      let length = second & 0x7f,
        offset = 2;
      if (length === 126) {
        if (this.buffered < 4) return;
        length = this.peek(4).readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffered < 10) return;
        const long = this.peek(10).readBigUInt64BE(2);
        if (long > BigInt(this.maximum)) violation();
        length = Number(long);
        offset = 10;
      }
      const control = opcode >= 8;
      if (control) {
        if (!fin || length > 125 || ![8, 9, 10].includes(opcode)) violation();
      } else if (
        (opcode === webSocketOpcodes.continuation) === (this.messageOpcode === undefined) ||
        opcode > 2 ||
        this.messageBytes + length > this.maximum
      )
        violation();
      const start = offset + (masked ? 4 : 0);
      if (this.buffered < start + length) return;
      buffer = this.peek(start + length);
      const payload = Buffer.from(buffer.subarray(start, start + length));
      if (masked) {
        const mask = buffer.subarray(offset, offset + 4);
        for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
      }
      this.consume(start + length);
      if (control) {
        yield { opcode, payload };
        continue;
      }
      if (opcode !== webSocketOpcodes.continuation) this.messageOpcode = opcode;
      this.message.push(payload);
      this.messageBytes += length;
      if (!fin) continue;
      const message = Buffer.concat(this.message, this.messageBytes);
      const messageOpcode = this.messageOpcode!;
      this.message = [];
      this.messageBytes = 0;
      this.messageOpcode = undefined;
      yield { opcode: messageOpcode, payload: message };
    }
  }
}
