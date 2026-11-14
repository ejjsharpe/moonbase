import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { test, type TestContext } from 'node:test';
import { Effect, Exit, Layer, ManagedRuntime, Scope, Stream } from 'effect';
import { rpcLimits, rpcPath, rpcProtocol } from '@moonbase/contracts/rpc-upgrade';
import { ChatService, type ChatServiceShape } from '@moonbase/contracts/services';
import { serveChat } from '../src/server.ts';
import { requestUpgradeNonce } from '../src/health.ts';
import { upgradeProtocols } from '../src/upgrade-proof.ts';
import { DaemonRpcLinkLive, EndpointConnectionLive, RemoteChatLive } from '../src/remote.ts';
import * as P from '../src/protocol.ts';
import { controlledChat, host, target } from './controlled-chat-fixture.ts';
import { refusingDaemon } from './served-services.ts';
import { until } from './runtime-fixture.ts';

async function serve(t: TestContext, chat: ChatServiceShape, rpcIdleMs?: number) {
  const token = P.nonce(),
    scope = Effect.runSync(Scope.make());
  const server = await Effect.runPromise(
    serveChat(
      { host, token, port: 0 },
      { chat, daemon: refusingDaemon() },
      rpcIdleMs === undefined ? {} : { rpcIdleMs },
    ).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  t.after(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const endpoint = { origin: server.origin, token, expected: host };
  const port = Number(new URL(server.origin).port);
  /** A fresh upgrade nonce, as a client fetches one from signed health before each connection. */
  const nonce = () =>
    Effect.runPromise(requestUpgradeNonce(endpoint)).then(({ upgradeNonce }) => upgradeNonce);
  return { token, port, endpoint, nonce };
}
/** The status line the daemon answers an RPC upgrade with, from a bare TCP socket. */
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
      request.line ?? `GET ${rpcPath} HTTP/1.1`,
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
const offered = (protocols: string[]) => ({ 'Sec-WebSocket-Protocol': protocols.join(', ') });
/** An authenticated RPC WebSocket, open once the daemon accepted its proof. */
async function openSocket(port: number, protocols: string[]) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${rpcPath}`, protocols);
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener('close', (event) => resolve(event.code)),
  );
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(Error('refused')), { once: true });
  });
  return { ws, closed };
}

test('an RPC upgrade is admitted only with a fresh proof of this host’s key, before Bun accepts it', async (t) => {
  const source = controlledChat();
  const { token, port, nonce } = await serve(t, source.client);
  const dispatched = source.calls.length;
  // A fresh proof is admitted, and the daemon speaks the RPC protocol back.
  const proof = upgradeProtocols(token, await nonce(), host);
  assert.match(await upgradeStatus(port, { headers: offered(proof) }), /^HTTP\/1\.1 101/);
  for (const [name, request, status] of [
    ['a replayed nonce', { headers: offered(proof) }, 401],
    ['the wrong key', { headers: offered(upgradeProtocols(P.nonce(), await nonce(), host)) }, 401],
    [
      'another host',
      { headers: offered(upgradeProtocols(token, await nonce(), { ...host, storeId: 'other' })) },
      401,
    ],
    [
      'a nonce health never issued',
      { headers: offered(upgradeProtocols(token, P.nonce(), host)) },
      401,
    ],
    [
      'another protocol',
      { headers: offered(['moonbase.rpc.v2', upgradeProtocols(token, await nonce(), host)[1]!]) },
      400,
    ],
    ['no proof', { headers: offered([rpcProtocol]) }, 400],
    ['no protocol', {}, 400],
    ['a browser page', { headers: { ...offered(proof), Origin: 'http://127.0.0.1' } }, 403],
    ['another host name', { headers: { ...offered(proof), Host: `localhost:${port}` } }, 400],
    ['a host that is no URL', { headers: { ...offered(proof), Host: 'a b<c>' } }, 400],
    ['a query', { line: `GET ${rpcPath}?x=1 HTTP/1.1`, headers: offered(proof) }, 400],
    ['another method', { line: `POST ${rpcPath} HTTP/1.1`, headers: offered(proof) }, 400],
    [
      'another WebSocket version',
      { headers: { ...offered(proof), 'Sec-WebSocket-Version': '8' } },
      400,
    ],
    ['a malformed key', { headers: { ...offered(proof), 'Sec-WebSocket-Key': 'nope' } }, 400],
  ] as const)
    assert.match(
      await upgradeStatus(port, request as never),
      new RegExp(`^HTTP/1\\.1 ${status}`),
      name,
    );
  // Past the connection cap an upgrade with a good proof is still refused.
  const open: Awaited<ReturnType<typeof openSocket>>[] = [];
  for (let index = 0; index < rpcLimits.connections; index++)
    open.push(await openSocket(port, upgradeProtocols(token, await nonce(), host)));
  t.after(() => open.forEach(({ ws }) => ws.close()));
  assert.match(
    await upgradeStatus(port, { headers: offered(upgradeProtocols(token, await nonce(), host)) }),
    /^HTTP\/1\.1 503/,
  );
  assert.deepEqual(
    source.calls.slice(dispatched).filter((call) => call !== 'getChatHost'),
    [],
  );
});

test('after the upgrade an oversized message or a silent client ends the connection', async (t) => {
  const source = controlledChat();
  const { token, port, nonce } = await serve(t, source.client, 200);
  const big = await openSocket(port, upgradeProtocols(token, await nonce(), host));
  big.ws.send(new Uint8Array(300 * 1024));
  assert.equal(await big.closed, 1009);
  const silent = await openSocket(port, upgradeProtocols(token, await nonce(), host));
  assert.equal(await silent.closed, 1008);
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
    code: 'Unavailable',
  });
  gate.resolve();
  await Promise.all(reads);
  await assert.rejects(runtime.runPromise(chat.findChatFiles({ target, query: 'a' })), (error) => {
    assert(!JSON.stringify(error).includes('private defect detail'));
    return (error as { code?: string }).code === 'Unavailable';
  });
  // A watch still runs on the same connection.
  const first = await runtime.runPromise(Stream.runHead(chat.watch({ target })));
  assert.equal(first._tag, 'Some');
});
