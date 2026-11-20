import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { connect } from 'node:net';
import { test, type TestContext } from 'node:test';
import { Deferred, Effect, Exit, Layer, ManagedRuntime, Scope, Stream } from 'effect';
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
import { ChatAccessError } from '@moonbase/contracts/chat-errors';
import { UnauthorizedError } from '@moonbase/contracts/errors';
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
  const { token, port, nonce, advance } = await serve(t, source.client);
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
    // A nonce is good only briefly: by the server's clock, one past its time is refused.
    const stale = await proofFor();
    await advance(rpcLimits.upgradeNonceMs);
    assert.match(
      await upgradeStatus(port, socket, { headers: offered(stale) }),
      /^HTTP\/1\.1 401/,
      `${socket.name}: an expired nonce`,
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

test('unauthenticated health probes are refused before they reach the chat service, and an authenticated one is refused only for an UnauthorizedError', async (t) => {
  const { client, calls } = controlledChat();
  // Once set, the chat service fails health's lookup with this.
  let failure: ChatAccessError | UnauthorizedError | undefined;
  const chat = new Proxy(client, {
    get: (source, name: keyof ChatServiceShape) =>
      name === 'getChatHost'
        ? (input: Parameters<ChatServiceShape['getChatHost']>[0]) =>
            failure ? Effect.fail(failure) : source.getChatHost(input)
        : source[name],
  });
  const { endpoint, token } = await serve(t, chat);
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
  // The chat service refusing the lookup leaves the host unavailable (503); only an
  // UnauthorizedError refuses the probe itself (401).
  for (const [refusal, reason] of [
    [new ChatAccessError({ refusal: 'other-owner' }), 'status'],
    [new UnauthorizedError({ operation: 'getChatHost' }), 'rejected'],
  ] as const) {
    failure = refusal;
    await assert.rejects(Effect.runPromise(checkHostHealth(endpoint)), { reason });
  }
});

test('before authentication Bun’s 16 KiB header bound refuses a request before the upgrade or health sees it, and no body is read', async (t) => {
  const source = controlledChat();
  const { token, port, nonce } = await serve(t, source.client);
  // Bun's own bound on a request's head is the daemon's before authentication; it adds none.
  const padding = { 'X-Padding': 'x'.repeat(20 * 1024) };
  for (const socket of sockets) {
    // A good proof with oversized headers is refused before the upgrade checks it, so its nonce
    // stays unused and opens the socket afterwards.
    const proof = upgradeProtocols(token, await nonce(), host, socket.protocol);
    const before = source.calls.length;
    assert.match(
      await upgradeStatus(port, socket, { headers: { ...offered(proof), ...padding } }),
      /^HTTP\/1\.1 431/,
      socket.name,
    );
    assert.deepEqual(source.calls.slice(before), [], socket.name);
    assert.match(
      await upgradeStatus(port, socket, { headers: offered(proof) }),
      /^HTTP\/1\.1 101/,
      socket.name,
    );
  }
  // A health probe with the token's proof and oversized headers never reaches health, which would
  // ask the chat service; the same probe within the bound is answered.
  const probe = randomNonce();
  const health = {
    line: 'GET /v1/health HTTP/1.1',
    headers: {
      Upgrade: undefined,
      Connection: undefined,
      'Sec-WebSocket-Version': undefined,
      'Sec-WebSocket-Key': undefined,
      'X-Moonbase-Nonce': probe,
      Authorization:
        'Moonbase-HMAC-SHA256 ' +
        createHmac('sha256', token)
          .update(JSON.stringify([healthDomain, 'request', probe]))
          .digest('hex'),
    },
  };
  const before = source.calls.length;
  assert.match(
    await upgradeStatus(port, sockets[0], {
      ...health,
      headers: { ...health.headers, ...padding },
    }),
    /^HTTP\/1\.1 431/,
  );
  assert.deepEqual(source.calls.slice(before), []);
  assert.match(await upgradeStatus(port, sockets[0], health), /^HTTP\/1\.1 200/);
  assert.deepEqual(source.calls.slice(before), ['getChatHost']);
  // A POST, for which Bun delivers a body, announces 64 MiB (under Bun's own 128 MiB bound, past
  // which it answers 413 itself) and sends none of it. It is answered at once rather than after a
  // body that never comes, so the listener reads no body before authentication.
  assert.match(
    await upgradeStatus(port, sockets[0], {
      line: 'POST /v1/health HTTP/1.1',
      headers: {
        ...health.headers,
        Authorization: undefined,
        'Content-Length': String(64 * 1024 * 1024),
      },
    }),
    /^HTTP\/1\.1 404/,
  );
  assert.deepEqual(source.calls.slice(before), ['getChatHost']);
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

test('the listener answers a bounded number of plain requests at once, and closing it interrupts those still running and waits a bounded time for their cleanup', async (t) => {
  const source = controlledChat();
  // Once the test holds them, authenticated probes are admitted and then wait on the chat
  // service, and releasing their admissions waits until the test ends.
  const released = Effect.runSync(Deferred.make<void>());
  t.after(() => Effect.runSync(Deferred.succeed(released, undefined)));
  let hold = false,
    admitted = 0,
    interrupted = 0,
    timedOut = false;
  const getChatHost: ChatServiceShape['getChatHost'] = (input) =>
    hold
      ? Effect.onInterrupt(Effect.never, () => Effect.sync(() => void interrupted++))
      : source.client.getChatHost(input);
  const chat = new Proxy(source.client, {
    get: (client, name: keyof ChatServiceShape) =>
      name === 'getChatHost' ? getChatHost : client[name],
  });
  const admit = Effect.acquireRelease(
    Effect.sync(() => (admitted++, hold)),
    (held) => (held ? Deferred.await(released) : Effect.void),
  );
  const closeMs = 1_000;
  const token = randomNonce(),
    runtime = ManagedRuntime.make(TestClock.layer()),
    scope = Effect.runSync(Scope.make());
  t.after(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
  });
  const advance = (ms: number) => runtime.runPromise(TestClock.adjust(ms));
  const server = await runtime.runPromise(
    serveChat(
      { host, token, port: 0 },
      { chat },
      { admit, closeMs, onCloseTimeout: Effect.sync(() => void (timedOut = true)) },
    ).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  const endpoint = { origin: server.origin, token, expected: host };
  const client = ManagedRuntime.make(
    RemoteChatLive.pipe(
      Layer.provide(DaemonRpcLinkLive({ host })),
      Layer.provide(EndpointConnectionLive(endpoint)),
    ),
  );
  t.after(() => client.dispose());
  const remote = await client.runPromise(ChatService);
  // A watch the RPC server runs until it closes.
  client.runFork(Stream.runDrain(remote.watch({ target })));
  await until(async () => source.watching, Boolean);
  hold = true;
  const before = admitted;
  const probes = Array.from({ length: 128 }, () =>
    Effect.runPromiseExit(checkHostHealth(endpoint)),
  );
  // Under the bound an unauthenticated probe is answered 401; past it, refused 503.
  await until(
    async () => {
      const response = await fetch(`${server.origin}/v1/health`);
      await response.arrayBuffer();
      return response.status;
    },
    (status) => status === 503,
  );
  assert.equal(admitted - before, 128);
  // Closing interrupts each probe, stops the listener and closes the RPC servers, which end the
  // watch, while every probe's release is still held.
  let closed = false;
  const closing = runtime.runPromise(Scope.close(scope, Exit.void)).then(() => (closed = true));
  await until(
    async () => [interrupted, source.closes] as const,
    ([probes, watches]) => probes === 128 && watches === 1,
  );
  await assert.rejects(fetch(`${server.origin}/v1/health`));
  // The close waits for those releases, up to `closeMs`, then goes on without them.
  await advance(closeMs - 1);
  assert.equal(closed, false);
  await until(async () => {
    await advance(1);
    return closed;
  }, Boolean);
  await closing;
  assert.equal(timedOut, true);
  for (const exit of await Promise.all(probes)) assert.equal(exit._tag, 'Failure');
});
