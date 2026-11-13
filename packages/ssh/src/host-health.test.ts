import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import { test, type TestContext } from 'node:test';
import { Cause, Effect, Exit } from 'effect';
import { ApplicationError, type ApplicationErrorCode } from '@moonbase/contracts/errors';
import {
  chatHostVersion,
  chatProtocolVersion,
  type ChatHostHealth,
} from '@moonbase/contracts/host';
import {
  checkHostHealth,
  createHostHealthReply,
  type ChatHostEndpoint,
  type HostHealthReply,
} from './host-health.ts';

const expected = { hostId: 'host-a', storeId: 'store-a' };
const health: ChatHostHealth = {
  ...expected,
  protocol: chatProtocolVersion,
  version: chatHostVersion,
  capabilities: ['chat-v0'],
};
const token = 'synthetic-health-test-token';
async function endpoint(t: TestContext, handler: RequestListener): Promise<ChatHostEndpoint> {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert(address && typeof address !== 'string');
  return { origin: `http://127.0.0.1:${address.port}`, token, expected };
}
async function fails(input: ChatHostEndpoint, code: ApplicationErrorCode) {
  const result = await Effect.runPromiseExit(checkHostHealth(input));
  assert(Exit.isFailure(result), 'health must fail');
  const failures = result.cause.reasons.flatMap((reason) => {
    if (Cause.isFailReason(reason)) return [reason.error];
    if (Cause.isDieReason(reason)) return [reason.defect];
    return [];
  });
  assert(
    failures.some((error) => ApplicationError.is(error) && error.code === code),
    `expected ${code}`,
  );
}

test('health authenticates the loopback request and retains the exact configured identity', async (t) => {
  let requests = 0;
  const input = await endpoint(t, (request, response) => {
    requests++;
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/v1/health');
    assert.match(request.headers.authorization ?? '', /^Moonbase-HMAC-SHA256 [a-f0-9]{64}$/);
    assert(!JSON.stringify(request.headers).includes(token));
    const reply = createHostHealthReply({
      token,
      health,
      nonce: request.headers['x-moonbase-nonce'] as string,
      authorization: request.headers.authorization,
    });
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(reply));
  });
  assert.deepEqual(await Effect.runPromise(checkHostHealth(input)), health);
  assert.equal(requests, 1);
});

test('an unsigned impostor cannot learn a reusable credential or pass health', async (t) => {
  let captured = '';
  const input = await endpoint(t, (request, response) => {
    captured = JSON.stringify({ url: request.url, headers: request.headers });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(health));
  });
  const result = await Effect.runPromiseExit(checkHostHealth(input));
  assert(!captured.includes(token), 'a listener without the configured key must not receive it');
  assert(Exit.isFailure(result), 'unsigned public identity is not host authentication');
});

test('health rejects reflected requests, replayed replies and tampered signed metadata', async (t) => {
  let mode = 'valid',
    original: HostHealthReply | undefined;
  const nonces = new Set<string>();
  const input = await endpoint(t, (request, response) => {
    const nonce = request.headers['x-moonbase-nonce'] as string;
    assert(!nonces.has(nonce));
    nonces.add(nonce);
    const valid = createHostHealthReply({
      token,
      health,
      nonce,
      authorization: request.headers.authorization,
    });
    original ??= valid;
    let reply = valid;
    if (mode === 'replay') reply = original;
    else if (mode === 'reflection')
      reply = { ...valid, proof: request.headers.authorization!.split(' ')[1] };
    else if (mode === 'tampered')
      reply = { ...valid, capabilities: [...valid.capabilities, 'changed'] };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(reply));
  });
  assert.deepEqual(await Effect.runPromise(checkHostHealth(input)), health);
  for (const changed of ['reflection', 'replay', 'tampered']) {
    mode = changed;
    await fails(input, 'Unauthorized');
  }
  mode = 'valid';
  const effect = checkHostHealth(input);
  assert.deepEqual(await Promise.all([Effect.runPromise(effect), Effect.runPromise(effect)]), [
    health,
    health,
  ]);
  assert.equal(nonces.size, 6);
});

test('the server health helper rejects an unproved client without returning a signed reply', () => {
  for (const authorization of [
    undefined,
    `Bearer ${token}`,
    'Moonbase-HMAC-SHA256 ' + '0'.repeat(64),
  ]) {
    assert.throws(
      () => createHostHealthReply({ token, health, nonce: 'A'.repeat(43), authorization }),
      (error) => ApplicationError.is(error) && error.code === 'Unauthorized',
    );
  }
});

test('wrong authentication is a typed rejection without including the token in errors', async (t) => {
  const input = await endpoint(t, (_request, response) => {
    response.writeHead(401);
    response.end('private server detail');
  });
  await fails(input, 'Unauthorized');
  const result = await Effect.runPromiseExit(checkHostHealth(input));
  assert(Exit.isFailure(result));
  assert(!String(result.cause).includes(token));
  assert(!String(result.cause).includes('private server detail'));
});

test('host, store, protocol, version and required capability mismatches fail closed', async (t) => {
  let value: unknown = health;
  const input = await endpoint(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(value));
  });
  for (const changed of [
    { hostId: 'other' },
    { storeId: 'other' },
    { protocol: 1 },
    { version: 'next' },
    { capabilities: [] },
  ]) {
    value = { ...health, ...changed };
    await fails(input, 'Incompatible');
  }
  value = { ...health, capabilities: Array(17).fill('chat-v0') };
  await fails(input, 'Incompatible');
});

test('invalid endpoint configuration is rejected before any network request', async (t) => {
  let requests = 0;
  const input = await endpoint(t, (_request, response) => {
    requests++;
    response.end();
  });
  for (const origin of [
    'https://127.0.0.1',
    'http://example.invalid',
    `${input.origin}/unexpected`,
    `${input.origin}?token=x`,
    `${input.origin}#fragment`,
    input.origin.replace('//', '//user:pass@'),
  ])
    await fails({ ...input, origin }, 'InvalidInput');
  await fails({ ...input, token: '' }, 'InvalidInput');
  await fails({ ...input, token: token + '\r\n' }, 'InvalidInput');
  await fails({ ...input, expected: { ...expected, storeId: '' } }, 'InvalidInput');
  assert.equal(requests, 0);
});

test('redirects are not followed with the host credential', async (t) => {
  let redirectedRequests = 0;
  const input = await endpoint(t, (request, response) => {
    if (request.url === '/redirected') {
      redirectedRequests++;
      response.end(JSON.stringify(health));
    } else {
      response.writeHead(302, { Location: '/redirected' });
      response.end();
    }
  });
  await fails(input, 'Unavailable');
  assert.equal(redirectedRequests, 0);
});

test('health bounds actual response bytes and rejects malformed or non-JSON data', async (t) => {
  let body: string | Buffer = '{}',
    type = 'text/html';
  const input = await endpoint(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': type });
    response.write(typeof body === 'string' ? body.slice(0, 4096) : body.subarray(0, 4096));
    response.end(typeof body === 'string' ? body.slice(4096) : body.subarray(4096));
  });
  await fails(input, 'Incompatible');
  type = 'application/json';
  body = '{';
  await fails(input, 'Incompatible');
  body = Buffer.from([0xff]);
  await fails(input, 'Incompatible');
  body = JSON.stringify({ ...health, padding: 'x'.repeat(9000) });
  await fails(input, 'Incompatible');
});

test(
  'cancelling health closes an in-flight response without owning the server',
  { timeout: 10000 },
  async (t) => {
    let enter!: () => void, close!: () => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      closed = new Promise<void>((resolve) => {
        close = resolve;
      });
    const input = await endpoint(t, (_request, response) => {
      response.on('close', close);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{');
      enter();
    });
    const abort = new AbortController();
    const result = Effect.runPromiseExit(checkHostHealth(input), { signal: abort.signal });
    await entered;
    abort.abort();
    const exit = await result;
    assert(Exit.isFailure(exit));
    assert(Cause.hasInterruptsOnly(exit.cause));
    await closed;
  },
);

test(
  'a stalled health body reaches its deadline and releases the response',
  { timeout: 10000 },
  async (t) => {
    let close!: () => void;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    const input = await endpoint(t, (_request, response) => {
      response.on('close', close);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{');
    });
    await fails(input, 'Unavailable');
    await closed;
  },
);

test('health proofs under the protocol 1 domain are refused both ways, and capabilities are signed', async (t) => {
  const oldProof = (phase: string, nonce: string, ...fields: unknown[]) =>
    createHmac('sha256', token)
      .update(JSON.stringify(['moonbase-health-v1', phase, nonce, ...fields]))
      .digest('hex');
  const nonce = 'A'.repeat(43);
  assert.throws(
    () =>
      createHostHealthReply({
        token,
        health,
        nonce,
        authorization: `Moonbase-HMAC-SHA256 ${oldProof('request', nonce)}`,
      }),
    { code: 'Unauthorized' },
  );
  const daemonHealth = {
    ...health,
    capabilities: ['chat-v0', 'daemon-local-v1', 'providers-v1', 'folders-v1'],
  };
  let reply: (nonce: string, authorization: string) => unknown = (nonce) => ({
    ...daemonHealth,
    nonce,
    proof: oldProof(
      'response',
      nonce,
      daemonHealth.protocol,
      daemonHealth.hostId,
      daemonHealth.storeId,
      daemonHealth.version,
      daemonHealth.capabilities,
    ),
  });
  const input = await endpoint(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify(
        reply(request.headers['x-moonbase-nonce'] as string, request.headers.authorization!),
      ),
    );
  });
  await fails(input, 'Unauthorized');
  reply = (nonce, authorization) =>
    createHostHealthReply({ token, health: daemonHealth, nonce, authorization });
  assert.deepEqual(await Effect.runPromise(checkHostHealth(input)), daemonHealth);
  // A reply that drops a capability it was signed with fails its proof.
  reply = (nonce, authorization) => ({
    ...createHostHealthReply({ token, health: daemonHealth, nonce, authorization }),
    capabilities: ['chat-v0'],
  });
  await fails(input, 'Unauthorized');
});
