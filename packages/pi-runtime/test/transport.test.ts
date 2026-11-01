import type { AddressInfo } from 'node:net';
import type { ChatInput, ChatStopTarget } from '@moonbase/application/chat-client';
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { connect as connectSocket } from 'node:net';
import { Effect, Exit, Layer, ManagedRuntime, Scope, Stream } from 'effect';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { makeChatClient } from '@moonbase/application/runtime-client';
import { ConnectionService, type VerifiedChatEndpoint } from '@moonbase/application/services';
import { ApplicationError } from '@moonbase/application/client';
import type { ChatClient } from '@moonbase/application/chat-client';
import { PiRuntimeLive } from '../src/index.ts';
import { RemoteChatLive } from '../src/remote.ts';
import { serveChat } from '../src/server.ts';

const host = { hostId: 'transport-host', storeId: 'transport-store' },
  session = { host, actorId: 'personal' },
  health = { ...host, protocol: 1 as const, version: '0.1.0' as const, capabilities: ['chat-v0'] };
const nonce = () => randomBytes(32).toString('base64url'),
  hash = (body: string | Uint8Array) => createHash('sha256').update(body).digest('hex');
const mac = (key: string, ...parts: unknown[]) =>
  createHmac('sha256', key)
    .update(JSON.stringify(['moonbase-chat-v1', ...parts]))
    .digest('hex');
const auth = (proof: string) => 'Moonbase-RPC-HMAC-SHA256 ' + proof;
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'moonbase-chat-http-')),
    models = createModels(),
    faux = fauxProvider({ tokensPerSecond: 100000 }),
    token = nonce();
  models.setProvider(faux.provider);
  const runtime = ManagedRuntime.make(
    PiRuntimeLive({
      ...session,
      cwd: dir,
      databasePath: join(dir, 'chat.sqlite'),
      models,
      model: { provider: faux.provider.id, modelId: faux.getModel().id },
    }),
  );
  const client = makeChatClient(runtime),
    calls: string[] = [];
  let intercept: ((operation: string) => Promise<void>) | undefined,
    afterDispatch: ((operation: string) => Promise<void>) | undefined;
  const bound: ChatClient = {
    command: async (operation, input, options) => {
      calls.push(operation);
      await intercept?.(operation);
      const value = await client.command(operation, input, options);
      await afterDispatch?.(operation);
      return value;
    },
    watch: client.watch,
  };
  let scope = Effect.runSync(Scope.make());
  let server = await runtime.runPromise(
    serveChat({ host, token, port: 0 }, bound).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  let endpoint: VerifiedChatEndpoint = {
    origin: server.origin,
    token,
    expected: host,
    connectionId: 'one',
    health,
  };
  let available = true;
  const unavailable = () =>
    Effect.fail(new ApplicationError({ code: 'Unavailable', message: 'Disconnected' }));
  const connections = Layer.succeed(ConnectionService, {
    getConnection: unavailable,
    connect: unavailable,
    disconnect: unavailable,
    watch: () => Stream.empty,
    endpoint: ({ host: expected }) =>
      Effect.suspend(() =>
        available && expected.hostId === host.hostId && expected.storeId === host.storeId
          ? Effect.succeed(structuredClone(endpoint))
          : unavailable(),
      ),
  });
  const remoteRuntime = ManagedRuntime.make(RemoteChatLive.pipe(Layer.provide(connections))),
    remote = makeChatClient(remoteRuntime);
  t.after(async () => {
    await remoteRuntime.dispose();
    await runtime.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    client,
    remote,
    faux,
    token,
    calls,
    get origin() {
      return server.origin;
    },
    set intercept(value: typeof intercept) {
      intercept = value;
    },
    set afterDispatch(value: typeof afterDispatch) {
      afterDispatch = value;
    },
    set endpoint(value: VerifiedChatEndpoint) {
      endpoint = value;
    },
    get endpoint() {
      return endpoint;
    },
    disconnect() {
      available = false;
    },
    reconnect() {
      available = true;
      endpoint = { ...endpoint, connectionId: nonce() };
    },
    async restartServer() {
      await runtime.runPromise(Scope.close(scope, Exit.void));
      scope = Effect.runSync(Scope.make());
      server = await runtime.runPromise(
        serveChat({ host, token, port: 0 }, bound).pipe(Effect.provideService(Scope.Scope, scope)),
      );
      endpoint = { ...endpoint, origin: server.origin, connectionId: 'two' };
    },
  };
}
async function grant(f: { origin: string; token: string }, clientNonce = nonce()) {
  const response = await fetch(f.origin + '/v1/chat/challenge', {
    headers: {
      'X-Moonbase-Nonce': clientNonce,
      Authorization: auth(
        mac(f.token, 'challenge-request', clientNonce, 'GET', '/v1/chat/challenge'),
      ),
    },
  });
  const raw = await response.text();
  assert.equal(
    response.headers.get('x-moonbase-proof'),
    mac(f.token, 'challenge-response', clientNonce, response.status, hash(raw)),
  );
  return { clientNonce, challenge: JSON.parse(raw).challenge as string, response };
}
function post(
  f: { origin: string; token: string },
  g: { clientNonce: string; challenge: string },
  operation: string,
  input: unknown,
  change?: string,
) {
  const body = JSON.stringify({ operation, input });
  return fetch(f.origin + '/v1/chat', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'X-Moonbase-Nonce': g.clientNonce,
      'X-Moonbase-Challenge': g.challenge,
      Authorization: auth(
        mac(
          f.token,
          'request',
          g.clientNonce,
          g.challenge,
          'POST',
          '/v1/chat',
          hash(change ?? body),
        ),
      ),
    },
  });
}
test('production remote/server route shared commands and immutable retries without key disclosure', async (t) => {
  const f = await setup(t);
  assert.deepEqual(
    await f.remote.command('getChatHost', { host }),
    await f.client.command('getChatHost', { host }),
  );
  const created = await f.remote.command('createChat', {
      session,
      requestId: 'create',
      title: 'Remote saved',
    }),
    target = created.conversation.target;
  f.faux.setResponses([fauxAssistantMessage('Reply')]);
  const input = { target, requestId: 'send', text: 'Private prompt' };
  const first = await f.remote.command('sendChat', input);
  assert.deepEqual(await f.remote.command('sendChat', input), first);
  await assert.rejects(f.remote.command('sendChat', { ...input, text: 'Changed' }), {
    code: 'InvalidInput',
  });
  assert.deepEqual(await f.remote.command('getChatSend', { target, requestId: 'send' }), first);
  const view = await f.remote.command('getChat', { target });
  assert(!JSON.stringify(view).includes(f.token));
  assert.equal(f.faux.state.callCount, 1);
  f.disconnect();
  const count = f.calls.length;
  await assert.rejects(f.remote.command('getChat', { target }), { code: 'Unavailable' });
  assert.equal(f.calls.length, count);
});
test('single-use challenges reject concurrent replay, tampering, unknown operation/shapes and wrong actors before mutations', async (t) => {
  const f = await setup(t),
    g = await grant(f);
  const posts = await Promise.all([
    post(f, g, 'createChat', { session, requestId: 'once', title: 'Only one' }),
    post(f, g, 'createChat', { session, requestId: 'once', title: 'Only one' }),
  ]);
  assert.deepEqual(posts.map((r) => r.status).sort(), [200, 401]);
  assert.equal(f.calls.filter((x) => x === 'createChat').length, 1);
  for (const response of posts) await response.arrayBuffer();
  const forged = await grant(f);
  assert.equal(
    (
      await post(
        f,
        forged,
        'createChat',
        { session, requestId: 'tamper', title: 'Forbidden' },
        'different bytes',
      )
    ).status,
    401,
  );
  assert.equal(
    (await post(f, forged, 'createChat', { session, requestId: 'tamper', title: 'Allowed' }))
      .status,
    200,
  );
  const before = f.calls.filter((x) => x === 'createChat').length;
  for (const [operation, input] of [
    ['unknown', {}],
    ['createChat', { session, requestId: 'bad', title: 'Bad', extra: true }],
    ['createChat', { session: { ...session, actorId: 'other' }, requestId: 'bad', title: 'Bad' }],
  ] as const) {
    const g = await grant(f),
      r = await post(f, g, operation, input);
    const value = await r.json();
    assert.equal(value.ok, false);
  }
  assert.equal((await f.client.command('listChats', { session })).conversations.length, 2);
  assert.equal(
    f.calls.filter((x) => x === 'createChat').length,
    before + 1,
    'wrong actor reaches domain validation, not mutation',
  );
});
test('server restart invalidates old grants; cache has bounded capacity without reactivating consumed grants', async (t) => {
  const f = await setup(t),
    old = await grant(f);
  await f.restartServer();
  assert.equal((await post(f, old, 'getChatHost', { host })).status, 401);
  const grants = [];
  for (let i = 0; i < 128; i++) grants.push(await grant(f));
  assert.equal((await grant(f)).response.status, 429);
  const first = grants[0];
  assert.equal((await post(f, first, 'getChatHost', { host })).status, 200);
  assert.equal((await post(f, first, 'getChatHost', { host })).status, 401);
  assert.equal((await grant(f)).response.status, 200);
});
test('remote drops successful and error responses from a stale connection generation', async (t) => {
  const f = await setup(t);
  let release!: () => void;
  let entered!: () => void;
  for (const failed of [false, true]) {
    const gate = new Promise<void>((r) => (release = r)),
      waiting = new Promise<void>((r) => (entered = r));
    f.intercept = async (operation) => {
      if (operation === 'listChats') {
        entered();
        await gate;
        if (failed) throw new ApplicationError({ code: 'Conflict', message: 'Private detail' });
      }
    };
    const call = f.remote.command('listChats', { session });
    await waiting;
    f.endpoint = { ...f.endpoint, connectionId: nonce() };
    release();
    await assert.rejects(call, { code: 'Unavailable' });
  }
  f.intercept = undefined;
});

for (const operation of ['createChat', 'sendChat', 'stopChat'] as const)
  for (const loss of ['disconnect', 'replacement'] as const)
    test(
      `R3 ${operation} generation ${loss} after dispatch preserves uncertainty and original identity`,
      { timeout: 10000 },
      async (t) => {
        const f = await setup(t);
        let release = () => {},
          releaseModel = () => {},
          entered = () => {};
        const held = new Promise<void>((resolve) => (release = resolve)),
          admitted = new Promise<void>((resolve) => (entered = resolve));
        t.signal.addEventListener(
          'abort',
          () => {
            release();
            releaseModel();
          },
          { once: true },
        );
        try {
          const target =
            operation === 'createChat'
              ? undefined
              : (
                  await f.remote.command('createChat', {
                    session,
                    requestId: 'setup',
                    title: 'Existing',
                  })
                ).conversation.target;
          let stop: ChatStopTarget | undefined;
          if (operation === 'stopChat') {
            const modelGate = new Promise<void>((resolve) => (releaseModel = resolve));
            f.faux.setResponses([
              async () => {
                await modelGate;
                return fauxAssistantMessage('Stopped work');
              },
            ]);
            await f.remote.command('sendChat', {
              target: target!,
              requestId: 'setup-send',
              text: 'Held work',
            });
            for (let i = 0; i < 100; i++) {
              const state = await f.client.command('getChat', { target: target! });
              if (state.run?.stop.taskId && f.faux.state.callCount === 1) {
                stop = state.run.stop;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert(stop, 'a captured actual task is required');
          } else f.faux.setResponses([fauxAssistantMessage('Saved once')]);
          f.afterDispatch = async (name) => {
            if (name === operation) {
              entered();
              await held;
            }
          };
          let input;
          if (operation === 'createChat') {
            input = { session, requestId: 'original-create', title: 'Captured create' };
          } else {
            if (operation === 'sendChat') {
              input = { target: target!, requestId: 'original-send', text: 'Captured Send' };
            } else {
              input = { stop: stop!, requestId: 'original-stop' };
            }
          }
          const pending = f.remote.command(operation, input);
          await admitted;
          if (loss === 'disconnect') f.disconnect();
          else f.endpoint = { ...f.endpoint, connectionId: nonce() };
          release();
          await assert.rejects(pending, { code: 'Uncertain' });
          f.afterDispatch = undefined;
          f.reconnect();
          assert.equal(f.calls.filter((name) => name === operation).length, 1);
          if (operation === 'createChat') {
            const saved = await f.client.command('listChats', { session });
            assert.equal(saved.conversations.length, 1);
            const retry = await f.remote.command('createChat', input as ChatInput<'createChat'>);
            assert.deepEqual(retry.conversation.target, saved.conversations[0].target);
          } else if (operation === 'sendChat') {
            const receipt = await f.remote.command('getChatSend', {
              target: target!,
              requestId: input.requestId,
            });
            assert.equal(receipt?.admission, 'admitted');
            assert.deepEqual(
              await f.remote.command('sendChat', input as ChatInput<'sendChat'>),
              receipt,
            );
            assert.equal(f.faux.state.callCount, 1);
          } else {
            const retry = await f.remote.command('stopChat', input as ChatInput<'stopChat'>);
            assert.deepEqual(retry.stop, stop);
            assert.equal(f.faux.state.callCount, 1);
          }
        } finally {
          release();
          releaseModel();
          f.afterDispatch = undefined;
        }
      },
    );

test('R3 disconnect during challenge keeps pre-dispatch Unavailable and discloses no mutation', async (t) => {
  const f = await setup(t),
    original = globalThis.fetch;
  let release = () => {},
    entered = () => {};
  const held = new Promise<void>((resolve) => (release = resolve)),
    received = new Promise<void>((resolve) => (entered = resolve));
  mock.method(
    globalThis,
    'fetch',
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const response = await original(input, init);
      if (String(input).endsWith('/v1/chat/challenge')) {
        entered();
        await held;
      }
      return response;
    },
  );
  try {
    const pending = f.remote.command('createChat', {
      session,
      requestId: 'not-disclosed',
      title: 'Private',
    });
    await received;
    f.disconnect();
    release();
    await assert.rejects(pending, { code: 'Unavailable' });
    assert.equal(
      f.calls.filter((name) => ['createChat', 'sendChat', 'stopChat'].includes(name)).length,
      0,
    );
    assert.equal((await f.client.command('listChats', { session })).conversations.length, 0);
  } finally {
    release();
    mock.restoreAll();
  }
});
test('remote rejects wrong listener proof or health before disclosing prompt', async (t) => {
  const f = await setup(t),
    requests: string[] = [];
  const impostor = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ challenge: nonce(), health }));
  });
  await new Promise<void>((r) => impostor.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => impostor.close(() => r())));
  f.endpoint = {
    ...f.endpoint,
    origin: `http://127.0.0.1:${(impostor.address() as AddressInfo).port}`,
  };
  await assert.rejects(
    f.remote.command('createChat', { session, requestId: 'private', title: 'Private title' }),
    { code: 'Unauthorized' },
  );
  assert.deepEqual(requests, ['']);
});

test('lost HTTP Send acknowledgement resolves through reconnect lookup without another model call', async (t) => {
  const f = await setup(t),
    target = (
      await f.remote.command('createChat', { session, requestId: 'create', title: 'Lost reply' })
    ).conversation.target;
  f.faux.setResponses([fauxAssistantMessage('Only once')]);
  let release!: () => void, entered!: () => void;
  const admitted = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  const abort = new AbortController();
  f.afterDispatch = async (operation) => {
    if (operation === 'sendChat') {
      entered();
      await gate;
    }
  };
  try {
    const input = { target, requestId: 'send', text: 'Original pending input' },
      pending = f.remote.command('sendChat', input, { signal: abort.signal });
    await admitted;
    abort.abort();
    await assert.rejects(pending, { code: 'Cancelled' });
    release();
    f.afterDispatch = undefined;
    f.endpoint = { ...f.endpoint, connectionId: 'reconnected' };
    const receipt = await f.remote.command('getChatSend', { target, requestId: 'send' });
    assert.equal(receipt?.admission, 'admitted');
    assert.deepEqual(await f.remote.command('sendChat', input), receipt);
    assert.equal(f.faux.state.callCount, 1);
  } finally {
    abort.abort();
    release();
    f.afterDispatch = undefined;
  }
});
test('actual 20-second grant expiry rejects an old RPC without dispatch and frees capacity', async (t) => {
  const f = await setup(t),
    g = await grant(f),
    before = f.calls.filter((x) => x === 'listChats').length;
  await new Promise((r) => setTimeout(r, 20100));
  const expired = await post(f, g, 'listChats', { session });
  assert.equal(expired.status, 401);
  await expired.arrayBuffer();
  assert.equal(f.calls.filter((x) => x === 'listChats').length, before);
  assert.equal((await grant(f)).response.status, 200);
});

test('signed hostile responses are bounded/projected and cannot reflect or tamper with authority', async (t) => {
  const f = await setup(t);
  let mode = 'normal',
    posts = 0;
  const impostor = createServer(async (req, res) => {
    const n = String(req.headers['x-moonbase-nonce']),
      challenge = String(req.headers['x-moonbase-challenge']);
    if (req.method === 'GET') {
      const body = JSON.stringify({
        challenge: nonce(),
        health: mode === 'wrong-health' ? { ...health, storeId: 'wrong' } : health,
      });
      res.writeHead(200, {
        'content-type': 'application/json',
        'X-Moonbase-Nonce': n,
        'X-Moonbase-Proof': mac(f.token, 'challenge-response', n, 200, hash(body)),
      });
      res.end(body);
      return;
    }
    posts++;
    for await (const _ of req) {
    }
    const value = {
      ...session,
      cwd: '/remote/fixed',
      model: 'configured/model',
      token: f.token,
      host: { ...host, privateKey: f.token },
    };
    let body = JSON.stringify({ ok: true, value });
    if (mode === 'oversized') body = ' '.repeat(256 * 1024 + 1);
    const pieces = body.split('configured/model'),
      wire =
        mode === 'utf8'
          ? Buffer.concat([Buffer.from(pieces[0]), Buffer.from([255]), Buffer.from(pieces[1])])
          : body;
    const signature =
      mode === 'reflection'
        ? mac(f.token, 'request', n, challenge, 'POST', '/v1/chat', hash(body))
        : mac(f.token, 'response', n, challenge, 200, hash(wire));
    res.writeHead(200, {
      'content-type': mode === 'type' ? 'text/plain' : 'application/json',
      'X-Moonbase-Nonce': mode === 'nonce' ? nonce() : n,
      'X-Moonbase-Challenge': mode === 'challenge' ? nonce() : challenge,
      'X-Moonbase-Proof': signature,
    });
    res.end(mode === 'tamper' ? body + ' ' : wire);
  });
  await new Promise<void>((r) => impostor.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => impostor.close(() => r())));
  f.endpoint = {
    ...f.endpoint,
    origin: `http://127.0.0.1:${(impostor.address() as AddressInfo).port}`,
  };
  const result = await f.remote.command('getChatHost', { host });
  assert(!JSON.stringify(result).includes(f.token));
  assert.deepEqual(result.host, host);
  for (mode of [
    'wrong-health',
    'reflection',
    'oversized',
    'type',
    'nonce',
    'challenge',
    'tamper',
    'utf8',
  ]) {
    const count = posts;
    await assert.rejects(
      f.remote.command('getChatHost', { host }),
      (e) =>
        !!e &&
        typeof e === 'object' &&
        'code' in e &&
        ['InvalidInput', 'Incompatible', 'Unauthorized'].includes(String(e.code)),
    );
    if (mode === 'wrong-health') assert.equal(posts, count);
  }
});
test('unknown shapes, canonical nonces, malformed Unicode and raw body limits reject before chat mutation', async (t) => {
  const f = await setup(t),
    before = f.calls.filter((x) => x === 'createChat').length;
  const r = await fetch(f.origin + '/v1/chat/challenge', {
    headers: {
      'X-Moonbase-Nonce': 'not-canonical',
      Authorization: 'Moonbase-RPC-HMAC-SHA256 ' + '0'.repeat(64),
    },
  });
  assert.equal(r.status, 401);
  await r.arrayBuffer();
  for (const title of ['\ud800', 'x'.repeat(201)]) {
    const g = await grant(f),
      response = await post(f, g, 'createChat', { session, requestId: 'bad', title });
    assert.equal((await response.json()).ok, false);
  }
  const g = await grant(f),
    body = JSON.stringify({
      operation: 'createChat',
      input: { session, requestId: 'big', title: 'x'.repeat(70000) },
    });
  await fetch(f.origin + '/v1/chat', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'X-Moonbase-Nonce': g.clientNonce,
      'X-Moonbase-Challenge': g.challenge,
      Authorization: auth(
        mac(f.token, 'request', g.clientNonce, g.challenge, 'POST', '/v1/chat', hash(body)),
      ),
    },
  }).then(
    async (r) => {
      assert.notEqual(r.status, 200);
      await r.arrayBuffer();
    },
    () => {},
  );
  const invalidGrant = await grant(f),
    parts = JSON.stringify({
      operation: 'createChat',
      input: { session, requestId: 'invalid-utf8', title: 'bad-byte-marker' },
    }).split('bad-byte-marker');
  const invalidBytes = Uint8Array.from(
    Buffer.concat([Buffer.from(parts[0]), Buffer.from([255]), Buffer.from(parts[1])]),
  );
  const invalid = await fetch(f.origin + '/v1/chat', {
    method: 'POST',
    body: invalidBytes,
    headers: {
      'content-type': 'application/json',
      'X-Moonbase-Nonce': invalidGrant.clientNonce,
      'X-Moonbase-Challenge': invalidGrant.challenge,
      Authorization: auth(
        mac(
          f.token,
          'request',
          invalidGrant.clientNonce,
          invalidGrant.challenge,
          'POST',
          '/v1/chat',
          hash(invalidBytes),
        ),
      ),
    },
  });
  assert.equal((await invalid.json()).ok, false);
  assert.equal(f.calls.filter((x) => x === 'createChat').length, before);
});

for (const deadline of [false, true])
  test(`remote ${deadline ? 'whole-request deadline' : 'caller cancellation'} releases a stalled RPC body reader`, async (t) => {
    const f = await setup(t),
      abort = new AbortController();
    let entered!: () => void, closed!: () => void;
    const started = new Promise<void>((r) => (entered = r)),
      released = new Promise<void>((r) => (closed = r));
    const server = createServer(async (req, res) => {
      const n = String(req.headers['x-moonbase-nonce']),
        challenge = String(req.headers['x-moonbase-challenge']);
      if (req.method === 'GET') {
        if (deadline) await new Promise((r) => setTimeout(r, 1500));
        const body = JSON.stringify({ challenge: nonce(), health });
        res.writeHead(200, {
          'content-type': 'application/json',
          'X-Moonbase-Nonce': n,
          'X-Moonbase-Proof': mac(f.token, 'challenge-response', n, 200, hash(body)),
        });
        res.end(body);
        return;
      }
      for await (const _ of req) {
      }
      const body = JSON.stringify({
        ok: true,
        value: { ...session, cwd: '/remote', model: 'configured' },
      });
      res.on('close', closed);
      res.writeHead(200, {
        'content-type': 'application/json',
        'X-Moonbase-Nonce': n,
        'X-Moonbase-Challenge': challenge,
        'X-Moonbase-Proof': mac(f.token, 'response', n, challenge, 200, hash(body)),
      });
      res.write('{');
      entered();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    });
    f.endpoint = {
      ...f.endpoint,
      origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    };
    const time = performance.now(),
      pending = f.remote.command('getChatHost', { host }, { signal: abort.signal });
    await started;
    if (!deadline) abort.abort();
    await assert.rejects(pending, { code: deadline ? 'Uncertain' : 'Cancelled' });
    await Promise.race([
      released,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(Error('RPC reader connection leaked')), 1500),
      ),
    ]);
    if (deadline) {
      const elapsed = performance.now() - time;
      assert(elapsed >= 19500 && elapsed < 21000, 'challenge and RPC used separate deadlines');
    }
    assert.equal((await f.client.command('getChatHost', { host })).actorId, 'personal');
  });
for (const generationLost of [false, true])
  test(
    generationLost
      ? 'R3 generation loss retains reader cleanup failure alongside mutation uncertainty'
      : 'unknown failing reader release retains uncertain mutation evidence and sanitizes the cleanup defect',
    async (t) => {
      const f = await setup(t),
        original = fetch,
        canary = 'private-reader-cleanup-canary';
      let once = true;
      mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
        const response = await original(...args);
        if (String(args[0]).endsWith('/v1/chat') && once) {
          once = false;
          const reader = response.body!.getReader();
          Object.defineProperty(response, 'body', {
            value: {
              getReader: () => ({
                read: async () => {
                  await reader.read();
                  if (generationLost) f.disconnect();
                  throw Error('Lost response after commit');
                },
                cancel: async () => {
                  await reader.cancel();
                  throw new Proxy(
                    {},
                    {
                      get() {
                        throw canary;
                      },
                    },
                  );
                },
                releaseLock: () => reader.releaseLock(),
              }),
            },
          });
        }
        return response;
      });
      try {
        await assert.rejects(
          f.remote.command('createChat', {
            session,
            requestId: 'uncertain-create',
            title: 'Retained',
          }),
          (e) =>
            ApplicationError.is(e) &&
            e.code === 'Uncertain' &&
            e.message.includes('reader release failed') &&
            !JSON.stringify(e).includes(canary),
        );
      } finally {
        mock.restoreAll();
      }
      if (generationLost) f.reconnect();
      const recovered = await f.remote.command('createChat', {
        session,
        requestId: 'uncertain-create',
        title: 'Retained',
      });
      assert.equal((await f.client.command('listChats', { session })).conversations.length, 1);
      assert.equal(recovered.requestId, 'uncertain-create');
      assert.equal(f.faux.state.callCount, 0);
    },
  );

test('pipelined HTTP requests have a bounded active window without queuing another application read', async (t) => {
  const f = await setup(t);
  let release!: () => void,
    entered = 0;
  const gate = new Promise<void>((r) => (release = r));
  f.intercept = async (operation) => {
    if (operation === 'getChatHost') {
      entered++;
      await gate;
    }
  };
  const url = new URL(f.origin),
    socket = connectSocket(Number(url.port), '127.0.0.1');
  let raw = '';
  const ended = new Promise<void>((resolve, reject) => {
    socket.on('data', (b) => (raw += b));
    socket.once('end', resolve);
    socket.once('error', reject);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    for (let i = 0; i < 129; i++) {
      const n = nonce();
      socket.write(
        `GET /v1/chat/challenge HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Moonbase-Nonce: ${n}\r\nAuthorization: ${auth(mac(f.token, 'challenge-request', n, 'GET', '/v1/chat/challenge'))}\r\n${i === 128 ? 'Connection: close\r\n' : ''}\r\n`,
      );
    }
    for (let i = 0; i < 300 && entered < 128; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(entered, 128);
    release();
    await ended;
    assert.equal(entered, 128);
    assert.equal((raw.match(/HTTP\/1\.1 200/g) ?? []).length, 128);
    assert.equal((raw.match(/HTTP\/1\.1 503/g) ?? []).length, 1);
    assert(!raw.includes(f.token));
  } finally {
    release();
    f.intercept = undefined;
    socket.destroy();
  }
});

test('private host key cannot reuse public configuration data', async (t) => {
  const f = await setup(t),
    configuration = await f.client.command('getChatHost', { host });
  await assert.rejects(
    Effect.runPromise(
      Effect.scoped(serveChat({ host, token: configuration.cwd, port: 0 }, f.client)),
    ),
    { code: 'InvalidInput' },
  );
});

for (const operation of ['createChat', 'sendChat'] as const)
  test(`R1 unauthenticated rejection cannot replace an executed ${operation} response`, async (t) => {
    const f = await setup(t),
      target =
        operation === 'sendChat'
          ? (
              await f.remote.command('createChat', {
                session,
                requestId: 'existing',
                title: 'Existing',
              })
            ).conversation.target
          : undefined;
    f.faux.setResponses([fauxAssistantMessage('Executed once')]);
    const original = fetch;
    let substituted = false,
      forgedProof: string | null | undefined;
    let failure: unknown;
    const input =
      operation === 'createChat'
        ? { session, requestId: 'relay-create', title: 'Persisted before reply' }
        : { target: target!, requestId: 'relay-send', text: 'Run exactly this intent' };
    mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
      const response = await original(...args);
      if (String(args[0]) === f.origin + '/v1/chat' && !substituted) {
        substituted = true;
        assert.equal(response.status, 200);
        await response.arrayBuffer();
        const observed = new Headers(args[1]?.headers);
        // The relay uses only observed public headers, with no key or Authorization proof.
        const replacement = await original(f.origin + '/v1/chat', {
          method: 'POST',
          headers: {
            'content-type': 'text/plain',
            'X-Moonbase-Nonce': observed.get('x-moonbase-nonce')!,
            'X-Moonbase-Challenge': observed.get('x-moonbase-challenge')!,
          },
          body: '',
        });
        forgedProof = replacement.headers.get('x-moonbase-proof');
        return replacement;
      }
      return response;
    });
    try {
      if (operation === 'createChat')
        await f.remote
          .command(
            operation,
            input as { session: typeof session; requestId: string; title: string },
          )
          .catch((error) => (failure = error));
      else
        await f.remote
          .command(
            operation,
            input as { target: NonNullable<typeof target>; requestId: string; text: string },
          )
          .catch((error) => (failure = error));
    } finally {
      mock.restoreAll();
    }
    assert(substituted);
    const saved = await f.client.command('listChats', { session });
    assert.equal(saved.conversations.length, 1);
    if (operation === 'createChat') {
      const recovered = await f.remote.command(
        'createChat',
        input as { session: typeof session; requestId: string; title: string },
      );
      assert.equal(
        recovered.conversation.target.conversationId,
        saved.conversations[0].target.conversationId,
      );
      assert.equal(f.faux.state.callCount, 0);
    } else {
      const receipt = await f.remote.command('getChatSend', {
        target: target!,
        requestId: 'relay-send',
      });
      assert.equal(receipt?.admission, 'admitted');
      for (let i = 0; i < 300 && f.faux.state.callCount === 0; i++)
        await new Promise((r) => setTimeout(r, 10));
      assert.equal(f.faux.state.callCount, 1);
      assert.deepEqual(
        await f.remote.command(
          'sendChat',
          input as { target: NonNullable<typeof target>; requestId: string; text: string },
        ),
        receipt,
      );
    }
    assert.equal(
      (failure as { code?: string })?.code,
      'Uncertain',
      'executed work appeared definitively rejected by a substituted response',
    );
    assert.equal(forgedProof, null, 'unauthenticated input obtained an authenticated RPC response');
  });

test('R1 pre-authentication malformed requests never obtain RPC signatures before or after grant consumption', async (t) => {
  const f = await setup(t);
  for (const state of ['arbitrary', 'live', 'consumed'])
    for (const mode of [
      'content-type',
      'oversized',
      'bad-proof',
      'malformed-json',
      'missing-auth',
    ]) {
      const g =
        state === 'arbitrary' ? { clientNonce: nonce(), challenge: nonce() } : await grant(f);
      if (state === 'consumed') {
        const consumed = await post(f, g, 'getChatHost', { host });
        assert.equal(consumed.status, 200);
        await consumed.arrayBuffer();
      }
      let body;
      if (mode === 'oversized') {
        body = 'x'.repeat(64 * 1024 + 1);
      } else {
        if (mode === 'malformed-json') {
          body = '{';
        } else {
          body = JSON.stringify({
            operation: 'createChat',
            input: { session, requestId: 'must-not-run', title: 'Untrusted' },
          });
        }
      }
      const headers: Record<string, string> = {
        'content-type': mode === 'content-type' ? 'text/plain' : 'application/json',
        'X-Moonbase-Nonce': g.clientNonce,
        'X-Moonbase-Challenge': g.challenge,
      };
      if (mode === 'bad-proof') headers.Authorization = auth('0'.repeat(64));
      const response = await fetch(f.origin + '/v1/chat', { method: 'POST', headers, body }).then(
        (value) => value,
        () => null,
      );
      if (response) {
        assert(response.status >= 400);
        assert.equal(
          response.headers.get('x-moonbase-proof'),
          null,
          `${state}/${mode} received a trusted error`,
        );
        assert.equal(response.headers.get('x-moonbase-challenge'), null);
        await response.arrayBuffer();
      }
      if (state === 'live') {
        const valid = await post(f, g, 'getChatHost', { host });
        assert.equal(valid.status, 200, 'unauthenticated input consumed another caller grant');
        await valid.arrayBuffer();
      }
    }
  assert.equal(f.calls.filter((value) => value === 'createChat').length, 0);
  assert.equal((await f.client.command('listChats', { session })).conversations.length, 0);
});
test('R1 authenticated consumed-request validation and domain rejections remain signed and specific', async (t) => {
  const f = await setup(t);
  for (const body of ['{', JSON.stringify({ operation: 'unknown', input: {} })]) {
    const g = await grant(f),
      headers = {
        'content-type': 'application/json',
        'X-Moonbase-Nonce': g.clientNonce,
        'X-Moonbase-Challenge': g.challenge,
        Authorization: auth(
          mac(f.token, 'request', g.clientNonce, g.challenge, 'POST', '/v1/chat', hash(body)),
        ),
      };
    const response = await fetch(f.origin + '/v1/chat', { method: 'POST', headers, body }),
      raw = await response.text();
    assert.equal(response.status, 400);
    assert.equal(
      response.headers.get('x-moonbase-proof'),
      mac(f.token, 'response', g.clientNonce, g.challenge, 400, hash(raw)),
    );
    assert.equal(JSON.parse(raw).error.code, 'InvalidInput');
    const replay = await fetch(f.origin + '/v1/chat', { method: 'POST', headers, body });
    assert.equal(replay.status, 401);
    assert.equal(replay.headers.get('x-moonbase-proof'), null);
    await replay.arrayBuffer();
  }
  await assert.rejects(
    f.remote.command('createChat', {
      session: { ...session, actorId: 'other' },
      requestId: 'wrong-actor',
      title: 'Rejected',
    }),
    { code: 'Unauthorized' },
  );
  const input = { session, requestId: 'original', title: 'Original' },
    created = await f.remote.command('createChat', input);
  await assert.rejects(f.remote.command('createChat', { ...input, title: 'Changed' }), {
    code: 'InvalidInput',
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  f.faux.setResponses([
    async () => {
      await gate;
      return fauxAssistantMessage('Completed');
    },
  ]);
  try {
    const target = created.conversation.target;
    await f.remote.command('sendChat', { target, requestId: 'active', text: 'Wait' });
    await assert.rejects(
      f.remote.command('sendChat', { target, requestId: 'busy', text: 'Busy' }),
      { code: 'Conflict' },
    );
    assert.equal(
      (await f.remote.command('getChatSend', { target, requestId: 'busy' }))?.admission,
      'reserved',
    );
  } finally {
    release();
  }
  assert.equal((await f.client.command('listChats', { session })).conversations.length, 1);
});
test('R1 incomplete pre-authentication request hits its real deadline without a signed rejection or dispatch', async (t) => {
  const f = await setup(t),
    g = await grant(f),
    started = performance.now();
  let request: ReturnType<typeof httpRequest> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proof = await new Promise<string | undefined>((resolve, reject) => {
      request = httpRequest(
        f.origin + '/v1/chat',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': '100',
            'X-Moonbase-Nonce': g.clientNonce,
            'X-Moonbase-Challenge': g.challenge,
          },
        },
        (response) => {
          const signature = response.headers['x-moonbase-proof'];
          response.resume();
          response.once('end', () =>
            resolve(typeof signature === 'string' ? signature : undefined),
          );
        },
      );
      request.once('error', () => resolve(undefined));
      request.write('{');
      timer = setTimeout(() => {
        request?.destroy();
        reject(Error('Server did not release incomplete input within its bound'));
      }, 22500);
    });
    assert.equal(proof, undefined);
    assert(performance.now() - started >= 19500);
    assert(performance.now() - started < 22500);
    assert.equal(f.calls.filter((value) => value === 'createChat').length, 0);
  } finally {
    clearTimeout(timer);
    request?.destroy();
  }
});
