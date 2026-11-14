import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { connect } from 'node:net';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { Effect, Exit, Queue, Scope, Stream, type Cause } from 'effect';
import type { ChatServiceShape, WorkspaceHostServiceShape } from '@moonbase/contracts/services';
import type {
  HostCommand,
  HostInput,
  HostOutput,
  WorkspaceHostClient,
} from '@moonbase/contracts/workspace-host';
import { type WorkspaceEvent } from '@moonbase/contracts/workspace';
import { socketLimits, socketPath } from '@moonbase/contracts/socket';
import { ApplicationError } from '@moonbase/contracts/errors';
import { checkHostHealth, healthDomain } from '../src/health.ts';
import { makeWorkspaceClient, serveChat, type SocketSources } from '../src/server.ts';
import { connectDaemonSocket } from '../src/socket-client.ts';
import {
  deriveSocketKeys,
  openSocketMessage,
  PayloadReassembly,
  sealSocketMessage,
  type SocketClock,
  type SocketKeys,
} from '../src/socket-protocol.ts';
import { encodeWebSocketFrame, WebSocketReader } from './websocket-frame-fixture.ts';
import * as P from '../src/protocol.ts';
import { controlledChat, host, session, target } from './controlled-chat-fixture.ts';
import { refusingDaemon } from './served-services.ts';
import { manualClock, until } from './runtime-fixture.ts';

async function serve(
  t: TestContext,
  chat: ChatServiceShape,
  options: {
    sources?: Partial<SocketSources>;
    clock?: SocketClock;
    workspace?: WorkspaceHostClient;
    admit?: () => () => void;
  } = {},
) {
  const token = P.nonce(),
    scope = Effect.runSync(Scope.make());
  const server = await Effect.runPromise(
    serveChat(
      { host, token, port: 0 },
      { chat, daemon: refusingDaemon() },
      {
        sources: { ...options.sources },
        ...(options.clock ? { clock: options.clock } : {}),
        ...(options.workspace ? { workspace: options.workspace } : {}),
        ...(options.admit ? { admit: options.admit } : {}),
      },
    ).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  t.after(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const port = Number(new URL(server.origin).port);
  return { token, port, endpoint: { origin: server.origin, token, expected: host } };
}
async function open(
  t: TestContext,
  endpoint: { origin: string; token: string; expected: typeof host },
  clock?: SocketClock,
) {
  const socket = await connectDaemonSocket(endpoint, clock ? { clock } : {});
  t.after(() => socket.close());
  return socket;
}

/** A WebSocket client on a bare TCP socket, for frames no conforming client would send. */
async function rawSocket(port: number, headers: Record<string, string> = {}) {
  const socket = connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  const reader = new WebSocketReader(1 << 30, false),
    messages: ({ opcode: number; payload: Buffer } | 'closed')[] = [];
  let head = Buffer.alloc(0),
    status: string | undefined;
  let wake: (() => void) | undefined;
  socket.on('data', (bytes: Buffer) => {
    if (status === undefined) {
      head = Buffer.concat([head, bytes]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      status = head.subarray(0, head.indexOf('\r\n')).toString();
      bytes = head.subarray(end + 4);
    }
    for (const message of reader.push(bytes)) messages.push(message);
    wake?.();
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    messages.push('closed');
    wake?.();
  });
  socket.write(
    [
      `GET ${socketPath} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${Buffer.alloc(16, 7).toString('base64')}`,
      ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
      '',
      '',
    ].join('\r\n'),
  );
  const next = async () => {
    for (let i = 0; i < 600 && !messages.length; i++)
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 10);
      });
    return messages.shift() ?? 'timeout';
  };
  return {
    socket,
    next,
    get status() {
      return status;
    },
    send: (payload: Uint8Array, opcode = 2, masked = true) =>
      socket.write(encodeWebSocketFrame(opcode, payload, masked)),
  };
}
type Raw = Awaited<ReturnType<typeof rawSocket>>;
/** Completes the handshake on a raw socket; returns the keys and both sides' next sequence. */
async function rawHello(raw: Raw, token: string, hello: Record<string, unknown> = {}) {
  const challenge = await raw.next();
  assert(challenge !== 'closed' && challenge !== 'timeout');
  const { challenge: value } = JSON.parse(challenge.payload.toString());
  const nonce = P.nonce(),
    keys = deriveSocketKeys(token, { nonce, challenge: value, host });
  const message = { type: 'hello', seq: 0, protocol: 2, host, nonce, ...hello };
  raw.send(sealSocketMessage(keys.client, message));
  return { keys, nonce, challenge: value, message };
}
async function readSealed(raw: Raw, keys: SocketKeys) {
  const message = await raw.next();
  if (message === 'closed' || message === 'timeout') return message;
  return openSocketMessage(keys.server, message.payload) as Record<string, unknown> & {
    type: string;
    seq: number;
  };
}
/**
 * What follows a refusal: only a close frame with the policy code and no reason, if anything.
 * Bun answers a ping itself, so the answer to a refused ping may come first.
 */
async function assertRefused(raw: Raw, framing = false) {
  for (;;) {
    const message = await raw.next();
    if (message === 'timeout') assert.fail('The connection stayed open.');
    if (message === 'closed') return;
    if (message.opcode === 10) continue;
    assert.equal(message.opcode, 8);
    // Bun refuses a malformed frame itself (a protocol error, text that isn't UTF-8 or a message
    // too big) with its own fixed reason; the session refuses the rest with the policy code and
    // no reason.
    if (framing) {
      assert([1002, 1007, 1009].includes(message.payload.readUInt16BE(0)));
      continue;
    }
    assert.deepEqual([...message.payload], [0x03, 0xf0]);
  }
}

/** The status line the daemon answers an upgrade request with, read from a bare TCP socket. */
async function upgradeStatus(
  port: number,
  request: { line?: string; headers?: Record<string, string | undefined> } = {},
) {
  const socket = connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  const headers: Record<string, string | undefined> = {
    Host: `127.0.0.1:${port}`,
    Upgrade: 'websocket',
    Connection: 'Upgrade',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': Buffer.alloc(16, 7).toString('base64'),
    ...request.headers,
  };
  let received = '';
  const status = new Promise<string>((resolve) => {
    socket.on('data', (bytes: Buffer) => {
      received += bytes.toString('latin1');
      const end = received.indexOf('\r\n');
      if (end >= 0) resolve(received.slice(0, end));
    });
    socket.on('close', () => resolve(received));
  });
  socket.on('error', () => {});
  socket.write(
    [
      request.line ?? `GET ${socketPath} HTTP/1.1`,
      ...Object.entries(headers)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}: ${value}`),
      '',
      '',
    ].join('\r\n'),
  );
  try {
    return await status;
  } finally {
    socket.destroy();
  }
}

test('the upgrade admits only a local client’s plain WebSocket handshake, within the connection cap', async (t) => {
  const source = controlledChat();
  const { port, endpoint } = await serve(t, source.client);
  const dispatched = source.calls.length;
  assert.match(await upgradeStatus(port), /^HTTP\/1\.1 101/);
  for (const [name, request, status] of [
    ['a browser page', { headers: { Origin: 'http://127.0.0.1' } }, 403],
    ['another host name', { headers: { Host: `localhost:${port}` } }, 400],
    ['a host without a port', { headers: { Host: '127.0.0.1' } }, 400],
    ['a host that is no URL', { headers: { Host: 'a b<c>' } }, 400],
    ['another path', { line: 'GET /v1/health HTTP/1.1' }, 400],
    ['a query', { line: `GET ${socketPath}?x=1 HTTP/1.1` }, 400],
    ['another method', { line: `POST ${socketPath} HTTP/1.1` }, 400],
    ['another WebSocket version', { headers: { 'Sec-WebSocket-Version': '8' } }, 400],
    ['a malformed key', { headers: { 'Sec-WebSocket-Key': 'not-a-key' } }, 400],
    [
      'a key of the wrong length',
      { headers: { 'Sec-WebSocket-Key': Buffer.alloc(15).toString('base64') } },
      400,
    ],
    ['another protocol', { headers: { Upgrade: 'h2c' } }, 400],
  ] as const)
    assert.match(await upgradeStatus(port, request), new RegExp(`^HTTP/1\\.1 ${status}`), name);
  // Past 32 authenticated connections an upgrade is refused before it is accepted.
  // One at a time: more than 8 waiting for their hello at once would evict each other.
  for (let index = 0; index < 32; index++) await open(t, endpoint);
  assert.match(await upgradeStatus(port), /^HTTP\/1\.1 503/);
  assert.equal(source.calls.length, dispatched);
});

test('the handshake and every authenticated frame refuse forgery, replay, reordering, oversize and invalid input without disclosure', async (t) => {
  const source = controlledChat(),
    clock = manualClock();
  const { token, port } = await serve(t, source.client, { clock });
  // A client that holds the token is welcomed, and its frames are answered.
  {
    const raw = await rawSocket(port);
    const { keys } = await rawHello(raw, token);
    const welcome = await readSealed(raw, keys);
    assert(welcome !== 'closed' && welcome !== 'timeout');
    assert.equal(welcome.type, 'welcome');
    assert.equal(welcome.seq, 0);
    raw.send(
      sealSocketMessage(keys.client, {
        type: 'request',
        seq: 1,
        id: 'r',
        operation: 'getChatHost',
        input: { host },
      }),
    );
    const reply = await readSealed(raw, keys);
    assert(reply !== 'closed' && reply !== 'timeout');
    assert.equal(reply.type, 'reply');
    // A request over an HTTP body's bound is refused, and the connection stays open.
    raw.send(
      sealSocketMessage(keys.client, {
        type: 'request',
        seq: 2,
        id: 'large',
        operation: 'getChatHost',
        input: { host, padding: 'x'.repeat(P.maximumChatRequestBytes) },
      }),
    );
    const large = await readSealed(raw, keys);
    assert(large !== 'closed' && large !== 'timeout');
    assert.equal(
      JSON.parse(Buffer.from(large.data as string, 'base64').toString()).error.code,
      'InvalidInput',
    );
    // Wire input is decoded here, once: a workspace input outside its schema is refused, and chat
    // and daemon operations are not served on this socket at all (they go over RPC).
    const served = source.calls.length;
    for (const [seq, operation, input, code] of [
      [3, 'readFile', { bogus: true }, 'InvalidInput'],
      [4, 'sendChat', { target, requestId: 'invalid', text: 'x' }, 'Incompatible'],
    ] as const) {
      raw.send(
        sealSocketMessage(keys.client, { type: 'request', seq, id: `r${seq}`, operation, input }),
      );
      const refused = await readSealed(raw, keys);
      assert(refused !== 'closed' && refused !== 'timeout');
      assert.equal(
        JSON.parse(Buffer.from(refused.data as string, 'base64').toString()).error.code,
        code,
      );
    }
    assert.equal(source.calls.length, served);
    raw.socket.destroy();
  }
  const dispatched = source.calls.length;
  type Fault = (raw: Raw) => Promise<void>;
  /** Sends a valid hello, reads the welcome and then sends what `after` makes. */
  const afterWelcome =
    (after: (keys: SocketKeys, raw: Raw) => void): Fault =>
    async (raw) => {
      const { keys } = await rawHello(raw, token);
      const welcome = await readSealed(raw, keys);
      assert(welcome !== 'closed' && welcome !== 'timeout' && welcome.type === 'welcome');
      after(keys, raw);
    };
  const request = (seq: number) => ({
    type: 'request',
    seq,
    id: `r${seq}`,
    operation: 'getChat',
    input: { target },
  });
  let captured: Buffer | undefined;
  const faults: Record<string, Fault> = {
    'wrong token': async (raw) => void (await rawHello(raw, P.nonce())),
    'wrong host': async (raw) =>
      void (await rawHello(raw, token, { host: { hostId: 'other', storeId: 'socket-store' } })),
    'wrong protocol': async (raw) => void (await rawHello(raw, token, { protocol: 1 })),
    'hello out of sequence': async (raw) => void (await rawHello(raw, token, { seq: 1 })),
    'hello replayed on another connection': async (raw) => {
      await raw.next();
      raw.send(captured!);
    },
    'ping before hello': async (raw) => {
      await raw.next();
      raw.send(Buffer.alloc(8), 9);
    },
    'request before hello': async (raw) => {
      await raw.next();
      raw.send(sealSocketMessage(Buffer.alloc(32), request(0)));
    },
    'tampered frame': afterWelcome((keys, raw) => {
      const frame = sealSocketMessage(keys.client, request(1));
      frame[frame.length - 3]! ^= 1;
      raw.send(frame);
    }),
    'tampered MAC': afterWelcome((keys, raw) => {
      const frame = sealSocketMessage(keys.client, request(1));
      frame[0]! ^= 1;
      raw.send(frame);
    }),
    'replayed frame': afterWelcome((keys, raw) => {
      const frame = sealSocketMessage(keys.client, { type: 'heartbeat', seq: 1 });
      raw.send(frame);
      raw.send(frame);
    }),
    'reordered frames': afterWelcome((keys, raw) => {
      raw.send(sealSocketMessage(keys.client, request(2)));
      raw.send(sealSocketMessage(keys.client, request(1)));
    }),
    'missing frame': afterWelcome((keys, raw) =>
      raw.send(sealSocketMessage(keys.client, request(2))),
    ),
    'server frame reflected': afterWelcome((keys, raw) =>
      raw.send(sealSocketMessage(keys.server, { type: 'heartbeat', seq: 1 })),
    ),
    'unknown field': afterWelcome((keys, raw) =>
      raw.send(sealSocketMessage(keys.client, { type: 'heartbeat', seq: 1, extra: true })),
    ),
    'oversized frame (framing)': afterWelcome((_keys, raw) => {
      // Only the header is sent: the length alone is refused, before any payload is buffered.
      const header = Buffer.alloc(14);
      header[0] = 0x82;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(socketLimits.frameBytes + 1), 2);
      raw.socket.write(header);
    }),
    'fragments that never complete a hello': async (raw) => {
      await raw.next();
      // Bun holds fragments until their message completes; these never do, so the hello's
      // deadline ends the connection.
      raw.socket.write(Buffer.from([0x02, 0x80, 0, 0, 0, 0]));
      raw.socket.write(
        Buffer.concat(Array.from({ length: 64 }, () => Buffer.from([0, 0x80, 0, 0, 0, 0]))),
      );
      clock.advance(socketLimits.handshakeMs);
    },
    'oversized hello': async (raw) => {
      await raw.next();
      raw.send(Buffer.alloc(8192, 0x20));
    },
    'unmasked frame (framing)': afterWelcome((keys, raw) =>
      raw.send(sealSocketMessage(keys.client, { type: 'heartbeat', seq: 1 }), 2, false),
    ),
    'text frame (framing)': afterWelcome((keys, raw) =>
      raw.send(sealSocketMessage(keys.client, { type: 'heartbeat', seq: 1 }), 1),
    ),
    'text message': afterWelcome((_keys, raw) => raw.send(Buffer.from('{"type":"heartbeat"}'), 1)),
    'late hello': async (raw) => {
      await raw.next();
      clock.advance(socketLimits.handshakeMs);
    },
  };
  {
    // A hello captured from one connection, for replaying on another.
    const raw = await rawSocket(port);
    const challenge = await raw.next();
    assert(challenge !== 'closed' && challenge !== 'timeout');
    const nonce = P.nonce(),
      keys = deriveSocketKeys(token, {
        nonce,
        challenge: JSON.parse(challenge.payload.toString()).challenge,
        host,
      });
    captured = sealSocketMessage(keys.client, { type: 'hello', seq: 0, protocol: 2, host, nonce });
    raw.socket.destroy();
  }
  for (const [name, fault] of Object.entries(faults)) {
    const raw = await rawSocket(port);
    await fault(raw);
    await assertRefused(raw, name.endsWith('(framing)')).catch((error: unknown) => {
      throw new Error(name, { cause: error });
    });
  }
  // Nothing refused reached the chat service.
  assert.equal(source.calls.length, dispatched);
});

test('a client refuses a daemon that cannot prove the token, skips a frame or never welcomes it', async (t) => {
  const token = P.nonce();
  for (const fault of ['wrong key', 'skipped sequence', 'held upgrade'] as const) {
    const server = createServer(),
      upgraded = new Set<{ destroy(): void }>();
    server.on('upgrade', (request, socket) => {
      upgraded.add(socket);
      if (fault === 'held upgrade') return;
      const accept = createHash('sha1')
        .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      const challenge = P.nonce();
      socket.write(
        encodeWebSocketFrame(
          2,
          Buffer.from(JSON.stringify({ type: 'challenge', protocol: 2, challenge })),
        ),
      );
      const reader = new WebSocketReader(1 << 20, true);
      socket.on('data', (bytes: Buffer) => {
        for (const { opcode, payload } of reader.push(bytes)) {
          if (opcode !== 2) continue;
          const hello = JSON.parse(payload.subarray(32).toString());
          const keys = deriveSocketKeys(fault === 'wrong key' ? P.nonce() : token, {
            nonce: hello.nonce,
            challenge,
            host,
          });
          const health = {
            ...host,
            protocol: 2,
            version: '0.1.0',
            capabilities: ['chat-v0', 'socket-v1'],
          };
          socket.write(
            encodeWebSocketFrame(
              2,
              sealSocketMessage(keys.server, {
                type: 'welcome',
                seq: fault === 'skipped sequence' ? 1 : 0,
                health,
              }),
            ),
          );
        }
      });
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
      for (const socket of upgraded) socket.destroy();
      server.closeAllConnections();
      server.close();
    });
    const { port } = server.address() as { port: number };
    const endpoint = { origin: `http://127.0.0.1:${port}`, token, expected: host };
    if (fault !== 'held upgrade') {
      await assert.rejects(connectDaemonSocket(endpoint), { code: 'Unauthorized' }, fault);
      continue;
    }
    // A slow forward gets the HTTP stream's establishment budget, past the server's hello bound.
    const clock = manualClock();
    let settled = false;
    const connecting = connectDaemonSocket(endpoint, { clock });
    void connecting.catch(() => {}).finally(() => (settled = true));
    await until(async () => upgraded.size, Boolean);
    clock.advance(socketLimits.connectMs - 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert(!settled);
    clock.advance(1);
    await assert.rejects(connecting, { code: 'Unavailable' });
  }
});

test('a ping flood that never reads stops being read and is dropped, and held handshakes give way to new ones', async (t) => {
  const source = controlledChat(),
    clock = manualClock();
  const { token, port, endpoint } = await serve(t, source.client, { clock });
  const client = await open(t, endpoint, clock);
  // Pings are answered, but the daemon stops reading once its answers go unread.
  const raw = await rawSocket(port);
  const { keys } = await rawHello(raw, token);
  assert.equal(((await readSealed(raw, keys)) as { type: string }).type, 'welcome');
  raw.socket.pause();
  const ping = encodeWebSocketFrame(9, Buffer.alloc(125, 1), true),
    batch = Buffer.concat(Array.from({ length: 1000 }, () => ping));
  // Flood until the daemon's unread answers pass its bound and it stops reading, which arms its
  // drain timer: however much the loopback buffers absorb, and however slowly it reads.
  await until(async () => {
    while (raw.socket.writableLength < 1024 * 1024) raw.socket.write(batch);
    return clock.hasTimer(socketLimits.drainMs);
  }, Boolean);
  // A flood left unread for `drainMs` is dropped.
  clock.advance(socketLimits.drainMs);
  raw.socket.resume();
  for (;;) {
    const message = await raw.next();
    if (message === 'closed') break;
    assert(message !== 'timeout' && [2, 8, 10].includes(message.opcode));
  }
  // Connections still waiting for a hello have their own bound: a new one evicts the oldest, so
  // a client still connects while every slot is held, and an authenticated one is unaffected.
  const waiting = await Promise.all(Array.from({ length: 8 }, () => rawSocket(port)));
  for (const pending of waiting) assert.notEqual(await pending.next(), 'timeout');
  const later = await open(t, endpoint, clock);
  await assertRefused(waiting.shift()!);
  assert.equal(later.health.hostId, host.hostId);
  assert.equal(client.health.hostId, host.hostId);
  clock.advance(socketLimits.handshakeMs);
  for (const pending of waiting) await assertRefused(pending);
});

test('unauthenticated health probes are refused before they reach the chat service', async (t) => {
  const { client, calls } = controlledChat();
  const served = await serve(t, client);
  const probe = P.nonce(),
    before = calls.length;
  const proof = (key: string) =>
    'Moonbase-HMAC-SHA256 ' +
    createHmac('sha256', key)
      .update(JSON.stringify([healthDomain, 'request', probe]))
      .digest('hex');
  for (const headers of [
    {},
    { 'X-Moonbase-Nonce': probe },
    { 'X-Moonbase-Nonce': probe, Authorization: 'Moonbase-HMAC-SHA256 ' + '0'.repeat(64) },
    { 'X-Moonbase-Nonce': probe, Authorization: proof(P.nonce()) },
  ] as Record<string, string>[]) {
    const response = await fetch(`${served.endpoint.origin}/v1/health`, { headers });
    assert.equal(response.status, 401);
    await response.arrayBuffer();
  }
  assert.deepEqual(calls.slice(before), []);
  // A probe with the token's proof is answered, after asking the chat service.
  await Effect.runPromise(
    checkHostHealth({ origin: served.endpoint.origin, token: served.token, expected: host }),
  );
  assert.deepEqual(calls.slice(before), ['getChatHost']);
});

// The workspace file host over the socket: chunked requests, bounded replies and its watch.
const checkout = {
  vcs: 'none',
  hostId: host.hostId,
  checkoutId: 'checkout-1',
  projectId: 'project-1',
  root: '/work',
} as const;
const fileTarget = { checkout, path: 'a.txt' };
const chunkBytes = socketLimits.chunkBytes;
type Handler = (input: never, signal?: AbortSignal) => Promise<unknown>;
/** A file host whose operations the test answers; unanswered ones fail. */
function controlledWorkspace() {
  const handlers: Partial<Record<HostCommand, Handler>> = {},
    calls: HostCommand[] = [];
  const client: WorkspaceHostClient = {
    command: async <K extends HostCommand>(
      operation: K,
      input: HostInput<K>,
      options?: { signal?: AbortSignal },
    ) => {
      calls.push(operation);
      const handler = handlers[operation];
      if (!handler)
        throw new ApplicationError({ code: 'Unavailable', message: 'Unexpected operation.' });
      return (await handler(input as never, options?.signal)) as HostOutput<K>;
    },
    watch: () => () => Promise.resolve(),
  };
  return { client, handlers, calls };
}
const saveInput = (text: string, requestId = 'save-1') => ({
  installationId: 'install',
  clientId: 'client',
  requestId,
  target: fileTarget,
  text,
  expectedVersion: 'v0',
});
/** The frames of a request body sent as chunks. */
const chunkMessages = (id: string, body: Buffer, total = body.length) =>
  Array.from({ length: Math.ceil(body.length / chunkBytes) }, (_, index) => ({
    type: 'requestChunk',
    id,
    offset: index * chunkBytes,
    total,
    data: body.subarray(index * chunkBytes, (index + 1) * chunkBytes).toString('base64'),
  }));
const padded = (size: number) =>
  Buffer.from(JSON.stringify({ operation: 'readFile', input: { padding: 'x'.repeat(size) } }));
/** An authenticated raw connection to a server that serves `workspace`, sealing frames in order. */
async function workspaceConnection(t: TestContext, workspace: WorkspaceHostClient) {
  const source = controlledChat(),
    clock = manualClock();
  const { token, port } = await serve(t, source.client, { clock, workspace });
  const raw = await rawSocket(port);
  const { keys } = await rawHello(raw, token);
  const welcome = await readSealed(raw, keys);
  assert(welcome !== 'closed' && welcome !== 'timeout' && welcome.type === 'welcome');
  assert((welcome.health as { capabilities: string[] }).capabilities.includes('workspace-v1'));
  let seq = 1;
  const seal = (message: Record<string, unknown>) =>
    sealSocketMessage(keys.client, { ...message, seq: seq++ });
  return {
    raw,
    keys,
    source,
    clock,
    seal,
    send: (message: Record<string, unknown>) => raw.send(seal(message)),
  };
}

const chunkFaults: Record<
  string,
  (c: Awaited<ReturnType<typeof workspaceConnection>>, body: Buffer) => void
> = {
  tampered: (c, body) => {
    const frame = c.seal(chunkMessages('r', body)[0]!);
    frame[40] ^= 1;
    c.raw.send(frame);
  },
  replayed: (c, body) => {
    const frame = c.seal(chunkMessages('r', body)[0]!);
    c.raw.send(frame);
    c.raw.send(frame);
  },
  reordered: (c, body) => c.send(chunkMessages('r', body)[1]!),
  interleaved: (c, body) => {
    c.send(chunkMessages('r', body)[0]!);
    c.send({ type: 'heartbeat' });
  },
  oversized: (c, body) =>
    c.send({
      ...chunkMessages('r', body)[0]!,
      data: Buffer.alloc(chunkBytes + 1, 1).toString('base64'),
    }),
  'over its total bound': (c, body) =>
    c.send({
      ...chunkMessages('r', body)[0]!,
      total: socketLimits.workspaceRequestBytes + 1,
    }),
  // Base64 whose padding hides set bits decodes, but is not the one encoding of its bytes.
  'non-canonical': (c, body) => c.send({ ...chunkMessages('r', body)[0]!, data: 'AB==' }),
  'chat operation': (c) => {
    const body = Buffer.from(
      JSON.stringify({
        operation: 'listChats',
        input: { session, padding: 'x'.repeat(chunkBytes) },
      }),
    );
    for (const message of chunkMessages('r', body)) c.send(message);
  },
};
for (const [name, fault] of Object.entries(chunkFaults))
  test(`a ${name} request chunk closes the connection`, async (t) => {
    const connection = await workspaceConnection(t, controlledWorkspace().client);
    fault(connection, padded(chunkBytes * 2));
    await assertRefused(connection.raw);
  });

test('a request past 32 MiB of chunked input in flight is refused Unavailable before it runs, a mutation too, and its discarded chunks are still checked', async (t) => {
  const { client, handlers, calls } = controlledWorkspace(),
    held = Promise.withResolvers<never>();
  handlers.getIgnoredPaths = () => held.promise;
  t.after(() => held.reject(Error('done')));
  // About 16.4 MB each: two fit, and each holds its input while the host runs it.
  const holding = {
    checkout,
    path: '',
    paths: Array.from({ length: 4100 }, () => 'x'.repeat(4000)),
  };
  const body = Buffer.from(JSON.stringify({ operation: 'getIgnoredPaths', input: holding }));
  assert(body.length < socketLimits.workspaceRequestBytes);
  assert(body.length * 3 > socketLimits.workspaceInFlightBytes);
  const { endpoint } = await serve(t, controlledChat().client, { workspace: client });
  const socket = await open(t, endpoint);
  for (let index = 0; index < 2; index++)
    void socket.request('getIgnoredPaths', holding).catch(() => {});
  await until(
    async () => calls.length,
    (count) => count === 2,
  );
  // A mutation that would pass the bound never runs, so it is `Unavailable`, not `Uncertain`, and
  // the connection carries on.
  const text = 'x'.repeat(1024 * 1024);
  await assert.rejects(socket.request('saveFile', saveInput(text)), { code: 'Unavailable' });
  assert.deepEqual(calls, ['getIgnoredPaths', 'getIgnoredPaths']);
  handlers.readFile = async () => ({ text: 'ok', version: 'v1' });
  assert.equal((await socket.request('readFile', fileTarget)).text, 'ok');

  // A discarded request's chunks are checked like any other's: a gap closes the connection.
  const connection = await workspaceConnection(t, client);
  for (const id of ['a', 'b'])
    for (const message of chunkMessages(id, body)) connection.send(message);
  const [first, , third] = chunkMessages('c', body);
  connection.send(first!);
  connection.send(third!);
  await assertRefused(connection.raw);
});

test('a 2 MiB file saves and reads back through chunks, a reply over its bound is refused unsent and a host without the capability is refused locally', async (t) => {
  const stored = new Map<string, string>(),
    { client, handlers, calls } = controlledWorkspace();
  handlers.saveFile = async (input: ReturnType<typeof saveInput>) => {
    stored.set(input.target.path, input.text);
    return { kind: 'saved', version: 'v1' };
  };
  handlers.readFile = async (input: { path: string }) =>
    input.path === 'huge'
      ? { text: 'x'.repeat(socketLimits.workspaceReplyBytes + 1), version: 'v1' }
      : { text: stored.get(input.path)!, version: 'v1' };
  const { endpoint } = await serve(t, controlledChat().client, { workspace: client });
  const socket = await open(t, endpoint);
  const text = 'line "quoted"\n'.repeat(Math.floor((2 * 1024 * 1024) / 14));
  assert(Buffer.byteLength(text) <= 2 * 1024 * 1024);
  const saved = await socket.request('saveFile', saveInput(text));
  assert.equal(saved.kind, 'saved');
  assert.equal((await socket.request('readFile', fileTarget)).text, text);
  // The host's reply is refused before any of it is sent; the connection carries on.
  await assert.rejects(socket.request('readFile', { checkout, path: 'huge' }), {
    code: 'InvalidInput',
  });
  assert.equal((await socket.request('readFile', fileTarget)).text, text);

  // A daemon that composes no file host advertises none; its clients send nothing to it.
  const bare = await serve(t, controlledChat().client);
  const plain = await open(t, bare.endpoint);
  assert(!plain.health.capabilities.includes('workspace-v1'));
  const before = calls.length;
  await assert.rejects(plain.request('readFile', fileTarget), { code: 'Incompatible' });
  assert.equal(calls.length, before);
  // A chunk to such a daemon is a protocol violation.
  const raw = await rawSocket(bare.port);
  const { keys } = await rawHello(raw, bare.token);
  await readSealed(raw, keys);
  raw.send(sealSocketMessage(keys.client, { seq: 1, ...chunkMessages('r', padded(100))[0]! }));
  await assertRefused(raw);
});

test('a workspace watch follows changes, resets after a reconnect, is bounded per connection and ends retryably when the host’s watch finishes', async (t) => {
  const watchers = new Set<Queue.Queue<WorkspaceEvent, Cause.Done>>();
  const service = {
    watch: () =>
      Stream.callback<WorkspaceEvent>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            watchers.add(queue);
            Queue.offerUnsafe(queue, { checkout, paths: [], ready: true });
          }),
          () => Effect.sync(() => void watchers.delete(queue)),
        ),
      ),
  } as unknown as WorkspaceHostServiceShape;
  const source = controlledChat();
  const { endpoint } = await serve(t, source.client, { workspace: makeWorkspaceClient(service) });
  const first = await open(t, endpoint);
  const values: { ready: boolean; revision: number }[] = [];
  const subscription = first.subscribe(
    'workspace',
    { checkout },
    { receive: (value) => values.push(value), onError: () => {} },
  );
  await until(async () => values.at(-1)?.ready, Boolean);
  const revision = values.at(-1)!.revision;
  for (const queue of watchers) Queue.offerUnsafe(queue, { checkout, paths: [''] });
  await until(
    async () => values.at(-1)!.revision,
    (value) => value > revision,
  );
  // A full set of workspace subscriptions.
  for (let index = 1; index < socketLimits.workspaceSubscriptions; index++)
    first.subscribe('workspace', { checkout }, { receive: () => {}, onError: () => {} });
  await until(
    async () => watchers.size,
    (count) => count === socketLimits.workspaceSubscriptions,
  );

  // A resumed workspace subscription always starts again from a snapshot: workspace
  // subscriptions are not kept to resume.
  const state = subscription.state!;
  await first.close();
  const second = await open(t, endpoint);
  const updates: string[] = [];
  second.subscribe(
    'workspace',
    { checkout },
    { receive: (_value, update) => updates.push(update), onError: () => {} },
    state,
  );
  await until(async () => updates.length, Boolean);
  assert.equal(updates[0], 'snapshot');

  // 64 workspace subscriptions fit on a connection; the next is refused.
  const refused: string[] = [],
    ended: string[] = [];
  for (let index = 1; index < socketLimits.workspaceSubscriptions; index++)
    second.subscribe(
      'workspace',
      { checkout },
      { receive: () => {}, onError: (error) => ended.push(error.code) },
    );
  second.subscribe(
    'workspace',
    { checkout },
    { receive: () => {}, onError: (error) => refused.push(error.code) },
  );
  await until(async () => refused.length, Boolean);
  assert.equal(refused[0], 'Unavailable');

  // A host watch that finishes ends its subscriptions as `Unavailable`, which a client retries.
  for (const queue of watchers) Queue.endUnsafe(queue);
  await until(
    async () => ended.length,
    (count) => count === socketLimits.workspaceSubscriptions - 1,
  );
  assert(ended.every((code) => code === 'Unavailable'));
});

test('a mutation whose reply is lost is Uncertain, runs to completion without a signal, and its outcome is read back by operationStatus', async (t) => {
  const { client, handlers } = controlledWorkspace(),
    gate = Promise.withResolvers<void>(),
    outcomes = new Map<string, unknown>();
  let signal: AbortSignal | undefined | 'none' = 'none';
  const operation = {
    installationId: 'install',
    id: 'op-1',
    clientId: 'client',
    checkout,
    kind: 'create-file' as const,
    sources: [],
    destination: 'new.txt',
    text: 'x',
  };
  handlers.mutate = async (_input, received) => {
    signal = received;
    await gate.promise;
    const result = {
      id: 'op-1',
      clientId: 'client',
      checkout,
      kind: 'create-file',
      outcome: 'completed',
      items: [],
    };
    outcomes.set('op-1', result);
    return result;
  };
  handlers.operationStatus = async () => outcomes.get('op-1') ?? null;
  const { endpoint } = await serve(t, controlledChat().client, { workspace: client });
  const first = await open(t, endpoint);
  const lost = first.request('mutate', operation);
  const rejected = assert.rejects(lost, { code: 'Uncertain' });
  await until(
    async () => signal,
    (value) => value !== 'none',
  );
  await first.close();
  await rejected;
  // The connection closing does not cancel the mutation.
  assert.equal(signal, undefined);
  gate.resolve();
  const second = await open(t, endpoint);
  const status = await until(
    () =>
      second.request('operationStatus', {
        installationId: 'install',
        clientId: 'client',
        id: 'op-1',
      }),
    Boolean,
  );
  assert.equal(status!.outcome, 'completed');
});

test('the daemon refuses a workspace request or watch for another host, and no handler runs', async (t) => {
  const { client, calls } = controlledWorkspace();
  const { endpoint } = await serve(t, controlledChat().client, { workspace: client });
  const socket = await open(t, endpoint);
  const foreign = { ...checkout, hostId: 'other-host' };
  await assert.rejects(socket.request('readFile', { checkout: foreign, path: 'a.txt' }), {
    code: 'Unauthorized',
  });
  // A chat named by another host is refused the same way.
  await assert.rejects(
    socket.request('turnChatIntoProject', {
      installationId: 'install',
      requestId: 'turn',
      target: { ...target, host: { ...host, hostId: 'other-host' } },
    }),
    { code: 'Unauthorized' },
  );
  const failures: string[] = [];
  socket.subscribe(
    'workspace',
    { checkout: foreign },
    { receive: () => {}, onError: (error) => failures.push(error.code) },
  );
  await until(async () => failures.length, Boolean);
  assert.deepEqual(failures, ['Unauthorized']);
  assert.deepEqual(calls, []);
});

test('a cancelled read frees its place on the daemon at once and the client’s once the daemon answers, and a queued reply it cancels is never sent', async (t) => {
  const { client, handlers, calls } = controlledWorkspace();
  // The host ignores the cancel: these reads never end.
  handlers.readFile = () => new Promise(() => {});
  const { endpoint } = await serve(t, controlledChat().client, { workspace: client });
  const socket = await open(t, endpoint);
  let settled = 0;
  const controllers = Array.from({ length: socketLimits.requests }, () => new AbortController());
  const reads = controllers.map((controller) =>
    socket.request('readFile', fileTarget, {
      signal: controller.signal,
      settled: () => void settled++,
    }),
  );
  await until(
    async () => calls.length,
    (count) => count === socketLimits.requests,
  );
  for (const controller of controllers) controller.abort();
  for (const read of reads) await assert.rejects(read, { code: 'Cancelled' });
  // The callers are told at once; each place is free once the daemon has answered the cancel.
  assert.equal(settled, 0);
  await until(
    async () => settled,
    (count) => count === socketLimits.requests,
  );
  // Every place on the daemon is free again although the host finished none of the reads.
  handlers.readFile = async () => ({ text: 'freed', version: 'v1' });
  assert.equal((await socket.request('readFile', fileTarget)).text, 'freed');

  // A reply waiting behind a large one while the client reads nothing is dropped for its cancel.
  const large = controlledWorkspace();
  large.handlers.readFile = async (input: { path: string }) => ({
    text: input.path === 'large' ? 'x'.repeat(15 * 1024 * 1024) : 'small',
    version: 'v1',
  });
  const c = await workspaceConnection(t, large.client);
  c.raw.socket.pause();
  c.send({
    type: 'request',
    id: 'large',
    operation: 'readFile',
    input: { checkout, path: 'large' },
  });
  c.send({ type: 'request', id: 'small', operation: 'readFile', input: fileTarget });
  await until(async () => c.clock.hasTimer(socketLimits.drainMs), Boolean);
  c.send({ type: 'cancel', id: 'small' });
  // Workspace replies go in order, so this one comes after anything left of the others.
  c.send({ type: 'request', id: 'after', operation: 'readFile', input: fileTarget });
  c.raw.socket.resume();
  const reassembly = new PayloadReassembly(),
    replies = new Map<
      string,
      { ok: boolean; value?: { text?: string }; error?: { code: string } }
    >(),
    order: string[] = [];
  while (!replies.has('after')) {
    const message = await readSealed(c.raw, c.keys);
    assert(message !== 'closed' && message !== 'timeout');
    if (message.type !== 'reply') continue;
    const done = reassembly.push(
      String(message.id),
      message as never,
      socketLimits.workspaceReplyBytes,
    );
    if (!done) continue;
    order.push(String(message.id));
    replies.set(String(message.id), done.value as never);
  }
  assert.equal(replies.get('small')!.error!.code, 'Cancelled');
  assert.equal(replies.get('large')!.value!.text!.length, 15 * 1024 * 1024);
  // One reply per request: the dropped one never follows.
  assert.deepEqual(order.toSorted(), ['after', 'large', 'small']);
});
