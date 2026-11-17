import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { connect } from 'node:net';
import { test, type TestContext } from 'node:test';
import { Effect, Exit, Layer, ManagedRuntime, Scope, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import {
  rpcLimits,
  rpcPath,
  rpcProtocol,
  workspaceRpcLimits,
  workspaceRpcPath,
  workspaceRpcProtocol,
} from '@moonbase/contracts/rpc-upgrade';
import {
  ChatService,
  type ChatServiceShape,
  type WorkspaceHostServiceShape,
} from '@moonbase/contracts/services';
import { serveChat } from '../src/server/server.ts';
import { checkHostHealth, healthDomain, requestUpgradeNonce } from '../src/health.ts';
import { upgradeProtocols } from '../src/upgrade-proof.ts';
import { DaemonRpcLinkLive, EndpointConnectionLive, RemoteChatLive } from '../src/client/remote.ts';
import { controlledChat, host, nonce as randomNonce, target } from './controlled-chat-fixture.ts';
import { refusingDaemon } from './served-services.ts';
import { until } from './runtime-fixture.ts';

/**
 * Serves `chat` and, unless `files` is false, a file host that answers nothing; the server's time
 * is a `TestClock` the test moves with `advance`.
 */
async function serve(t: TestContext, chat: ChatServiceShape, files = true) {
  const token = randomNonce(),
    runtime = ManagedRuntime.make(TestClock.layer()),
    scope = Effect.runSync(Scope.make());
  const workspace = {} as WorkspaceHostServiceShape;
  const server = await runtime.runPromise(
    serveChat(
      { host, token, port: 0 },
      { chat, daemon: refusingDaemon() },
      files ? { workspace } : {},
    ).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  t.after(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
  });
  const advance = (ms: number) => runtime.runPromise(TestClock.adjust(ms));
  const endpoint = { origin: server.origin, token, expected: host };
  const port = Number(new URL(server.origin).port);
  /** A fresh upgrade nonce, as a client fetches one from signed health before each connection. */
  const nonce = () =>
    Effect.runPromise(requestUpgradeNonce(endpoint)).then(({ upgradeNonce }) => upgradeNonce);
  return { token, port, endpoint, nonce, advance };
}
/** The two sockets a daemon serves, each upgraded with its own protocol. */
const sockets = [
  { name: 'RPC', path: rpcPath, protocol: rpcProtocol, cap: rpcLimits.connections },
  {
    name: 'workspace',
    path: workspaceRpcPath,
    protocol: workspaceRpcProtocol,
    cap: workspaceRpcLimits.connections,
  },
] as const;
type Socket = (typeof sockets)[number];
/** The status line the daemon answers an upgrade of `socket` with, from a bare TCP socket. */
async function upgradeStatus(
  port: number,
  socket: Socket,
  request: { line?: string; headers?: Record<string, string | undefined> } = {},
) {
  const tcp = connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => tcp.once('connect', resolve).once('error', reject));
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
    tcp.on('data', (bytes: Buffer) => {
      received += bytes.toString('latin1');
      const end = received.indexOf('\r\n');
      if (end >= 0) resolve(received.slice(0, end));
    });
    tcp.on('close', () => resolve(received));
  });
  tcp.on('error', () => {});
  tcp.write(
    [
      request.line ?? `GET ${socket.path} HTTP/1.1`,
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
    tcp.destroy();
  }
}
const offered = (protocols: string[]) => ({ 'Sec-WebSocket-Protocol': protocols.join(', ') });
/** An authenticated WebSocket to `socket`, open once the daemon accepted its proof. */
async function openSocket(port: number, socket: Socket, protocols: string[]) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${socket.path}`, protocols);
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener('close', (event) => resolve(event.code)),
  );
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(Error('refused')), { once: true });
  });
  return { ws, closed };
}

test('each socket admits an upgrade only with a fresh proof of this host’s key for its own protocol, before Bun accepts it', async (t) => {
  const source = controlledChat();
  const { token, port, nonce } = await serve(t, source.client);
  const dispatched = source.calls.length;
  for (const socket of sockets) {
    const other = sockets.find((each) => each !== socket)!;
    const proofFor = async (protocol: string = socket.protocol, key = token, of = host) =>
      upgradeProtocols(key, await nonce(), of, protocol);
    // A fresh proof is admitted, and the daemon speaks the socket's protocol back.
    const proof = await proofFor();
    assert.match(
      await upgradeStatus(port, socket, { headers: offered(proof) }),
      /^HTTP\/1\.1 101/,
      socket.name,
    );
    const [, otherProof] = await proofFor(other.protocol);
    for (const [name, request, status] of [
      ['a replayed nonce', { headers: offered(proof) }, 401],
      ['the wrong key', { headers: offered(await proofFor(socket.protocol, randomNonce())) }, 401],
      [
        'another host',
        { headers: offered(await proofFor(socket.protocol, token, { ...host, storeId: 'other' })) },
        401,
      ],
      [
        'a nonce health never issued',
        { headers: offered(upgradeProtocols(token, randomNonce(), host, socket.protocol)) },
        401,
      ],
      // A proof binds the protocol it was made for: one for the other socket opens only that one.
      ['a proof for the other socket', { headers: offered([socket.protocol, otherProof!]) }, 401],
      ['the other socket’s protocol', { headers: offered(await proofFor(other.protocol)) }, 400],
      ['another protocol', { headers: offered(['moonbase.rpc.v2', (await proofFor())[1]!]) }, 400],
      ['no proof', { headers: offered([socket.protocol]) }, 400],
      ['no protocol', {}, 400],
      ['a browser page', { headers: { ...offered(proof), Origin: 'http://127.0.0.1' } }, 403],
      ['another host name', { headers: { ...offered(proof), Host: `localhost:${port}` } }, 400],
      ['a host without a port', { headers: { ...offered(proof), Host: '127.0.0.1' } }, 400],
      ['a host that is no URL', { headers: { ...offered(proof), Host: 'a b<c>' } }, 400],
      ['a query', { line: `GET ${socket.path}?x=1 HTTP/1.1`, headers: offered(proof) }, 400],
      ['another path', { line: 'GET /v2/socket HTTP/1.1', headers: offered(proof) }, 400],
      ['another method', { line: `POST ${socket.path} HTTP/1.1`, headers: offered(proof) }, 400],
      [
        'another WebSocket version',
        { headers: { ...offered(proof), 'Sec-WebSocket-Version': '8' } },
        400,
      ],
      ['a malformed key', { headers: { ...offered(proof), 'Sec-WebSocket-Key': 'nope' } }, 400],
      [
        'a key of the wrong length',
        {
          headers: { ...offered(proof), 'Sec-WebSocket-Key': Buffer.alloc(15).toString('base64') },
        },
        400,
      ],
      ['another upgrade', { headers: { ...offered(proof), Upgrade: 'h2c' } }, 400],
    ] as const)
      assert.match(
        await upgradeStatus(port, socket, request as never),
        new RegExp(`^HTTP/1\\.1 ${status}`),
        `${socket.name}: ${name}`,
      );
    // Past the socket's connection cap an upgrade with a good proof is still refused, while the
    // other socket has places of its own.
    const open: Awaited<ReturnType<typeof openSocket>>[] = [];
    t.after(() => open.forEach(({ ws }) => ws.close()));
    for (let index = 0; index < socket.cap; index++)
      open.push(await openSocket(port, socket, await proofFor()));
    assert.match(
      await upgradeStatus(port, socket, { headers: offered(await proofFor()) }),
      /^HTTP\/1\.1 503/,
    );
    const beside = await openSocket(port, other, await proofFor(other.protocol));
    beside.ws.close();
    for (const { ws } of open.splice(0)) ws.close();
    await until(
      async () => upgradeStatus(port, socket, { headers: offered(await proofFor()) }),
      (status) => status.startsWith('HTTP/1.1 101'),
    );
  }
  // Upgrades that arrive together hold their places as they are accepted, so no more than the cap
  // open even before any of them has.
  for (const socket of sockets) {
    const proofs = [];
    for (let index = 0; index < socket.cap + 8; index++)
      proofs.push(upgradeProtocols(token, await nonce(), host, socket.protocol));
    const attempts = await Promise.allSettled(
      proofs.map((proof) => openSocket(port, socket, proof)),
    );
    const opened = attempts.flatMap((attempt) =>
      attempt.status === 'fulfilled' ? [attempt.value] : [],
    );
    opened.forEach(({ ws }) => ws.close());
    assert.equal(opened.length, socket.cap, socket.name);
    await Promise.all(opened.map(({ closed }) => closed));
  }
  // A daemon that composes no file host serves no workspace socket.
  const bare = await serve(t, controlledChat().client, false);
  assert.match(
    await upgradeStatus(bare.port, sockets[1], {
      headers: offered(
        upgradeProtocols(bare.token, await bare.nonce(), host, workspaceRpcProtocol),
      ),
    }),
    /^HTTP\/1\.1 400/,
  );
  assert.deepEqual(
    source.calls.slice(dispatched).filter((call) => call !== 'getChatHost'),
    [],
  );
});

test('after the upgrade a message past its socket’s bound or a silent client ends the connection', async (t) => {
  const source = controlledChat();
  const { token, port, nonce, advance } = await serve(t, source.client);
  const [rpc, workspace] = sockets;
  const big = await openSocket(
    port,
    rpc,
    upgradeProtocols(token, await nonce(), host, rpc.protocol),
  );
  big.ws.send(new Uint8Array(rpcLimits.messageBytes + 1));
  assert.equal(await big.closed, 1009);
  // The workspace socket takes a message the RPC socket refuses, up to its own bound.
  const files = await openSocket(
    port,
    workspace,
    upgradeProtocols(token, await nonce(), host, workspace.protocol),
  );
  let filesClosed: number | undefined;
  void files.closed.then((code) => (filesClosed = code));
  files.ws.send(new Uint8Array(rpcLimits.messageBytes + 1));
  files.ws.send(new Uint8Array(workspaceRpcLimits.messageBytes + 1));
  assert.equal(await files.closed, 1009);
  assert.equal(filesClosed, 1009);
  const silent = await openSocket(
    port,
    workspace,
    upgradeProtocols(token, await nonce(), host, workspace.protocol),
  );
  let code: number | undefined;
  void silent.closed.then((closed) => (code = closed));
  // Short of its idle bound the connection stays open; at the bound it closes.
  await advance(rpcLimits.idleMs - 1);
  assert.equal(code, undefined);
  await until(async () => {
    await advance(rpcLimits.idleMs);
    return code;
  }, Boolean);
  assert.equal(code, 1008);
});

test('unauthenticated health probes are refused before they reach the chat service', async (t) => {
  const { client, calls } = controlledChat();
  const { endpoint, token } = await serve(t, client);
  const probe = randomNonce(),
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
    { 'X-Moonbase-Nonce': probe, Authorization: proof(randomNonce()) },
  ] as Record<string, string>[]) {
    const response = await fetch(`${endpoint.origin}/v1/health`, { headers });
    assert.equal(response.status, 401);
    await response.arrayBuffer();
  }
  assert.deepEqual(calls.slice(before), []);
  // A probe with the token's proof is answered, after asking the chat service.
  await Effect.runPromise(checkHostHealth({ origin: endpoint.origin, token, expected: host }));
  assert.deepEqual(calls.slice(before), ['getChatHost']);
});

test('a connection runs a bounded number of requests at once, and a handler’s defect is a fixed Unavailable', async (t) => {
  const source = controlledChat(),
    gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  let held = 0;
  source.handlers.getChatHistory = async () => {
    held++;
    await gate.promise;
    return { entries: [], olderCursor: null, newerCursor: null };
  };
  source.handlers.findChatFiles = async () => {
    throw new Error('private defect detail');
  };
  const { endpoint } = await serve(t, source.client);
  const runtime = ManagedRuntime.make(
    RemoteChatLive.pipe(
      Layer.provide(DaemonRpcLinkLive({ host })),
      Layer.provide(EndpointConnectionLive(endpoint)),
    ),
  );
  t.after(() => runtime.dispose());
  const chat = await runtime.runPromise(ChatService);
  const reads = Array.from({ length: rpcLimits.requests }, () =>
    runtime.runPromise(chat.getChatHistory({ target, cursor: 'c' })).catch(() => {}),
  );
  await until(
    async () => held,
    (count) => count === rpcLimits.requests,
  );
  await assert.rejects(runtime.runPromise(chat.getChatHistory({ target, cursor: 'c' })), {
    _tag: 'HostUnavailableError',
    reason: 'busy',
  });
  gate.resolve();
  await Promise.all(reads);
  await assert.rejects(runtime.runPromise(chat.findChatFiles({ target, query: 'a' })), (error) => {
    assert(!JSON.stringify(error).includes('private defect detail'));
    return (error as { reason?: string }).reason === 'failed';
  });
  // A watch still runs on the same connection.
  const first = await runtime.runPromise(Stream.runHead(chat.watch({ target })));
  assert.equal(first._tag, 'Some');
});
