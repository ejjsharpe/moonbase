import { randomBytes } from 'node:crypto';

// RFC 6455 framing for tests that speak to the daemon on a raw socket, as a client that reads
// slowly. The daemon itself leaves framing to Bun.

/** One unfragmented frame; a client masks what it sends and a server never does. */
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
