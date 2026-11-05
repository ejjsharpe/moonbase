import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { ServerResponse } from 'node:http';
import { Harness } from '@earendil-works/pi-durable';
import { fixture as piFixture } from './runtime-fixture.ts';
import { Effect, Exit, Layer, ManagedRuntime, Scope, Stream, Queue } from 'effect';
import type { ChatClient, ChatSnapshot, ChatStreamFrame } from '@moonbase/contracts/chat';
import { ChatService, ConnectionService } from '@moonbase/contracts/services';
import { ApplicationError } from '@moonbase/contracts/errors';
import { makeChatClient } from '@moonbase/application/runtime/clients';
import { serveChat } from '../src/server.ts';
import { RemoteChatLive } from '../src/remote.ts';
import * as P from '../src/protocol.ts';

const host = { hostId: 'stream-host', storeId: 'stream-store' };
const target = { host, actorId: 'owner', conversationId: 'A' };
const snapshot: ChatSnapshot = {
  conversation: {
    target,
    title: 'A',
    createdAt: '2026-11-04T00:00:00Z',
    cwd: '/controlled',
    model: 'faux',
  },
  entries: [],
  olderCursor: null,
  run: null,
  state: 'idle',
  transcriptBoundary: null,
};
const wait = async (predicate: () => boolean) => {
  const end = Date.now() + 6000;
  while (!predicate()) {
    if (Date.now() > end) throw Error('Stream deadline');
    await new Promise((r) => setTimeout(r, 5));
  }
};
async function fixture(t: TestContext, holdInitial = false) {
  const token = P.nonce(),
    listeners = new Set<(value: ChatSnapshot) => void>(),
    calls: string[] = [],
    sourceErrors = new Set<(error: ApplicationError) => void>();
  let sourceError: ApplicationError | undefined;
  let acquisitions = 0,
    releases = 0,
    current = snapshot,
    replacementChecks = 0;
  const bound: ChatClient = {
    command: async (operation) => {
      calls.push(operation);
      if (operation === 'getChatHost')
        return { host, actorId: target.actorId, cwd: '/controlled', model: 'faux' } as never;
      if (operation === 'getChat') return snapshot as never;
      throw Error('Unexpected command');
    },
    watch: (_, receive, onError) => {
      acquisitions++;
      sourceErrors.add(onError);
      listeners.add(receive);
      if (sourceError) queueMicrotask(() => onError(sourceError!));
      else if (!holdInitial) queueMicrotask(() => receive(current));
      return async () => {
        releases++;
        listeners.delete(receive);
        sourceErrors.delete(onError);
      };
    },
  };
  const scope = Effect.runSync(Scope.make());
  const server = await Effect.runPromise(
    serveChat({ host, token, port: 0 }, bound).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  const changes = Effect.runSync(Queue.unbounded<void>());
  let endpoint = {
    origin: server.origin,
    token,
    expected: host,
    connectionId: 'one',
    health: { ...host, protocol: 1 as const, version: '0.1.0' as const, capabilities: ['chat-v0'] },
  };
  const unavailable = () =>
    Effect.fail(
      new ApplicationError({ code: 'Unavailable', message: 'No implicit connection commands' }),
    );
  const connection = Layer.succeed(ConnectionService, {
    getConnection: unavailable,
    connect: unavailable,
    disconnect: unavailable,
    endpoint: () =>
      Effect.sync(() => {
        if (endpoint.connectionId === 'two') replacementChecks++;
        return endpoint;
      }),
    watch: () =>
      Stream.fromQueue(changes).pipe(
        Stream.map(
          () =>
            ({
              state: 'connected',
              connectionId: endpoint.connectionId,
              health: endpoint.health,
              profile: {
                id: 'profile',
                label: 'Controlled',
                destination: 'controlled',
                remotePort: 1,
                expected: host,
              },
            }) as const,
        ),
      ),
  });
  const runtime = ManagedRuntime.make(RemoteChatLive.pipe(Layer.provide(connection))),
    client = makeChatClient(runtime);
  t.after(async () => {
    await runtime.dispose();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
  const observe = () => {
    const views: ChatSnapshot[] = [],
      errors: ApplicationError[] = [];
    const close = client.watch(
      { target },
      (value) => views.push(value),
      (error) => errors.push(error),
    );
    t.after(() => close().catch(() => {}));
    return { views, errors, close };
  };
  return {
    origin: server.origin,
    token,
    failSource: (error: ApplicationError, persistent = false) => {
      if (persistent) sourceError = error;
      sourceErrors.forEach((onError) => onError(error));
    },
    client,
    runtime,
    get replacementChecks() {
      return replacementChecks;
    },
    calls,
    observe,
    listeners,
    get acquisitions() {
      return acquisitions;
    },
    get releases() {
      return releases;
    },
    publish: (value: ChatSnapshot) => {
      current = value;
      listeners.forEach((receive) => receive(value));
    },
    replace: () => {
      endpoint = { ...endpoint, connectionId: 'two' };
      Queue.offerUnsafe(changes, undefined);
    },
  };
}
function interceptFrames(
  t: TestContext,
  token: string,
  change: (
    frames: Buffer[],
    attempt: number,
    context: { nonce: string; challenge: string },
  ) => Uint8Array[],
  holdOpen = false,
) {
  const original = fetch;
  let attempts = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const response = await original(url, init);
      if (!String(url).endsWith(P.streamPath)) return response;
      const attempt = attempts++;
      const nonce = new Headers(init?.headers).get('x-moonbase-nonce')!,
        challenge = new Headers(init?.headers).get('x-moonbase-challenge')!;
      const reader = response.body!.getReader();
      const decoder = new P.FrameDecoder();
      const frames: Buffer[] = [];
      while (!frames.length) {
        const part = await reader.read();
        if (part.done) throw Error('No initial frame');
        for (const frame of decoder.push(part.value)) {
          const value = P.json(frame.body) as ChatStreamFrame;
          frames.push(P.encodeFrame(token, nonce, challenge, value));
        }
      }
      await reader.cancel();
      reader.releaseLock();
      const parts = change(frames, attempt, { nonce, challenge });
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            if (!holdOpen) controller.close();
          },
        }),
        { headers: response.headers, status: response.status },
      );
    },
  );
  return () => attempts;
}

test('installed endpoint alone advertises streaming, delivers replacements without getChat and fences generation/close', async (t) => {
  const f = await fixture(t);
  assert((await f.client.command('getChatHost', { host })).features?.includes('chat-stream-v1'));
  const w = f.observe();
  await wait(() => w.views.length === 1);
  assert.equal(w.views[0].observationStatus, 'connected');
  f.publish({ ...snapshot, message: 'progress' });
  await wait(() => w.views.length === 2);
  await new Promise((r) => setTimeout(r, 550));
  assert.equal(f.calls.filter((c) => c === 'getChat').length, 0);
  f.replace();
  await wait(() => w.errors.length === 1);
  f.publish({ ...snapshot, message: 'late' });
  assert.equal(w.views.length, 2);
  await assert.rejects(w.close(), { code: 'Unavailable' });
  await wait(() => f.listeners.size === 0);
  assert.equal(f.acquisitions, f.releases);
});

test('actual envelope bounds and 32KiB chunks reconstruct escaped snapshots through fragmented/coalesced reads', async (t) => {
  const f = await fixture(t),
    w = f.observe();
  await wait(() => w.views.length === 1);
  const large = {
    ...snapshot,
    entries: Array.from({ length: 32 }, (_, i) => ({
      id: String(i + 1),
      role: 'assistant' as const,
      text: '\u0001'.repeat(1000),
      truncated: false,
    })),
  };
  f.publish(large);
  await wait(() => w.views.length === 2);
  assert.deepEqual(w.views[1].entries, large.entries);
  const frames = Array.from({ length: 3 }, (_, sequence) =>
    P.encodeFrame(f.token, 'nonce', 'challenge', { value: '\\😀'.repeat(200), sequence }),
  );
  const all = Buffer.concat(frames),
    decoder = new P.FrameDecoder(),
    values: unknown[] = [];
  for (let offset = 0; offset < all.length; offset += 7)
    for (const frame of decoder.push(all.subarray(offset, offset + 7)))
      values.push(P.json(frame.body));
  assert.equal(values.length, 3);
  assert.equal(decoder.partial, false);
  assert.equal([...new P.FrameDecoder().push(all)].length, 3);
  assert.throws(() => [...new P.FrameDecoder().push(Buffer.from([0, 4, 0, 0]))], {
    code: 'Incompatible',
  });
  assert.throws(() => P.encodeFrame(f.token, '', '', { value: 'x'.repeat(262144) }), {
    code: 'Incompatible',
  });
  await w.close();
});

for (const fault of [
  'tamper',
  'reflection',
  'wrong-target',
  'wrong-generation',
  'reorder',
  'missing',
  'replay',
  'malformed',
] as const)
  test(`authenticated stream rejects ${fault} before publication`, async (t) => {
    const f = await fixture(t);
    const original = fetch;
    t.mock.method(
      globalThis,
      'fetch',
      async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const response = await original(url, init);
        if (!String(url).endsWith(P.streamPath)) return response;
        const headers = new Headers(init?.headers),
          nonce = headers.get('x-moonbase-nonce')!,
          challenge = headers.get('x-moonbase-challenge')!;
        const body = JSON.stringify(
          fault === 'malformed' ? { ...snapshot, state: 'unknown' } : snapshot,
        );
        const value = {
          target,
          connectionId: 'one',
          streamId: P.nonce(),
          sequence: 0,
          kind: 'snapshot',
          offset: 0,
          total: Buffer.byteLength(body),
          data: Buffer.from(body).toString('base64'),
        };
        const bad = {
          ...value,
          ...(fault === 'wrong-target' ? { target: { ...target, actorId: 'foreign' } } : {}),
          ...(fault === 'wrong-generation' ? { connectionId: 'two' } : {}),
          ...(fault === 'reorder' || fault === 'missing' ? { sequence: 1 } : {}),
        };
        const frame = P.encodeFrame(
          f.token,
          fault === 'replay' ? P.nonce() : nonce,
          challenge,
          bad,
        );
        if (fault === 'tamper') frame[6] ^= 1;
        if (fault === 'reflection')
          Buffer.from(
            P.mac(f.token, 'frame', nonce, challenge, P.hash(frame.subarray(4, -32))),
            'hex',
          ).copy(frame, frame.length - 32);
        await response.body!.cancel();
        return new Response(frame, { headers: response.headers });
      },
    );
    const w = f.observe();
    await wait(() => w.errors.length > 0);
    assert.equal(w.views.length, 0);
    assert(['Unauthorized', 'Incompatible'].includes(w.errors[0].code));
    await wait(() => f.listeners.size === 0);
  });

test('snapshot/disconnect loops have a finite retry budget, visible stale state and no polling/mutation replay', async (t) => {
  const f = await fixture(t),
    attempts = interceptFrames(t, f.token, (frames) => frames);
  const w = f.observe();
  await wait(() => w.errors.length > 0);
  assert.equal(attempts(), 4);
  assert(w.views.some((v) => v.observationStatus === 'reconnecting'));
  assert.equal(w.errors[0].code, 'Unavailable');
  assert.equal(
    w.views.at(-1)!.observationStatus,
    'reconnecting',
    'terminal failure must leave retained content stale',
  );
  assert.deepEqual(w.views.at(-1)!.conversation.target, target);
  assert.equal(w.views.at(-1)!.transcriptBoundary, snapshot.transcriptBoundary);
  assert.equal(f.calls.filter((c) => c !== 'getChatHost').length, 0);
  await wait(() => f.listeners.size === 0);
  assert.equal(f.acquisitions, f.releases);
});

test('closing a held reader releases the server watch promptly and drops later replacements', async (t) => {
  const f = await fixture(t),
    w = f.observe();
  await wait(() => w.views.length === 1);
  await w.close();
  await wait(() => f.listeners.size === 0);
  f.publish({ ...snapshot, message: 'late' });
  assert.equal(w.views.length, 1);
  assert.deepEqual(w.errors, []);
});

test('stream challenges cannot authorize RPC or be reused across endpoint establishment', async (t) => {
  const f = await fixture(t);
  // Use the actual server origin observed from the authenticated remote request.
  const original = fetch;
  let origin = '';
  t.mock.method(globalThis, 'fetch', (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    origin = new URL(String(url)).origin;
    return original(url, init);
  });
  await f.client.command('getChatHost', { host });
  const nonce = P.nonce();
  const response = await original(origin + '/v1/chat/challenge', {
    headers: {
      'X-Moonbase-Nonce': nonce,
      Authorization: `Moonbase-RPC-HMAC-SHA256 ${P.mac(f.token, 'challenge-request', nonce, 'GET', '/v1/chat/challenge')}`,
    },
  });
  const { challenge } = (await response.json()) as { challenge: string };
  const body = JSON.stringify({ target, connectionId: 'one' }),
    headers = {
      'content-type': 'application/json',
      'X-Moonbase-Nonce': nonce,
      'X-Moonbase-Challenge': challenge,
      Authorization: `Moonbase-RPC-HMAC-SHA256 ${P.streamMac(f.token, 'request', nonce, challenge, 'POST', P.streamPath, P.hash(body))}`,
    };
  const wrong = await original(origin + '/v1/chat', { method: 'POST', body, headers });
  assert.equal(wrong.status, 401);
  const accepted = await original(origin + P.streamPath, { method: 'POST', body, headers });
  assert.equal(accepted.status, 200);
  await accepted.body!.cancel();
  const replay = await original(origin + P.streamPath, { method: 'POST', body, headers });
  assert.equal(replay.status, 401);
});

test('64 subscriptions leave ordinary reads usable; excess observations fail and all slots release', async (t) => {
  const f = await fixture(t),
    observers = Array.from({ length: 64 }, () => f.observe());
  await wait(() => observers.every((w) => w.views.length === 1));
  const extra = f.observe();
  await wait(() => extra.errors.length === 1);
  assert.equal(extra.errors[0].code, 'Unavailable');
  assert.equal(f.acquisitions, 64);
  assert((await f.client.command('getChatHost', { host })).features?.includes('chat-stream-v1'));
  await Promise.all(observers.map((w) => w.close()));
  await wait(() => f.listeners.size === 0);
  const next = f.observe();
  await wait(() => next.views.length === 1);
  await next.close();
});

test('a superseded replacement burst retains current state without accumulating per-update frames', async (t) => {
  const f = await fixture(t),
    w = f.observe();
  await wait(() => w.views.length === 1);
  for (let i = 0; i < 1000; i++) f.publish({ ...snapshot, message: String(i) });
  await wait(() => w.views.at(-1)?.message === '999');
  assert(w.views.length < 10);
  await w.close();
});

function shortenDeadline(t: TestContext, duration: number) {
  const original = setTimeout;
  t.mock.method(globalThis, 'setTimeout', ((
    callback: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => original(callback, ms === duration ? 40 : ms, ...args)) as typeof setTimeout);
}
test('establishment/first snapshot is bounded and releases a held observation without polling fallback', async (t) => {
  shortenDeadline(t, P.streamLimits.establishmentMs);
  const f = await fixture(t, true),
    w = f.observe();
  await wait(() => w.errors.length === 1);
  assert.equal(w.views.length, 0);
  assert.equal(w.errors[0].code, 'Unavailable');
  assert.equal(f.acquisitions, 4);
  await wait(() => f.listeners.size === 0);
  assert(!f.calls.includes('getChat'));
});
test('idle expiry is bounded separately after the initial snapshot', async (t) => {
  shortenDeadline(t, P.streamLimits.idleMs);
  const f = await fixture(t),
    w = f.observe();
  await wait(() => w.errors.length === 1);
  assert(w.views.some((v) => v.observationStatus === 'reconnecting'));
  assert.equal(f.acquisitions, 4);
});

test('legacy capability absence retains the 250ms polling path and never opens a stream', async (t) => {
  const f = await fixture(t),
    original = fetch;
  let streams = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(url).endsWith(P.streamPath)) streams++;
      const response = await original(url, init);
      if (!init?.body || JSON.parse(String(init.body)).operation !== 'getChatHost') return response;
      const envelope = (await response.json()) as { value: { features?: string[] } };
      delete envelope.value.features;
      const bytes = JSON.stringify(envelope),
        headers = new Headers(response.headers);
      headers.set(
        'x-moonbase-proof',
        P.mac(
          f.token,
          'response',
          headers.get('x-moonbase-nonce'),
          headers.get('x-moonbase-challenge'),
          response.status,
          P.hash(bytes),
        ),
      );
      headers.delete('content-length');
      return new Response(bytes, { headers, status: response.status });
    },
  );
  const w = f.observe();
  await wait(() => w.views.length >= 3);
  await w.close();
  assert.equal(streams, 0);
  assert.equal(f.acquisitions, 0);
  assert(f.calls.filter((c) => c === 'getChat').length >= 3);
  assert.deepEqual(w.errors, []);
});

test('an exact repeated frame is rejected while verified content becomes stale without accepting replayed data', async (t) => {
  const f = await fixture(t);
  interceptFrames(t, f.token, (frames) => [frames[0], frames[0]]);
  const w = f.observe();
  await wait(() => w.errors.length === 1);
  assert(w.views.length >= 1 && w.views.length <= 2);
  for (const { observationStatus: _status, ...retained } of w.views)
    assert.deepEqual(retained, snapshot);
  assert.equal(w.views.at(-1)!.observationStatus, 'reconnecting');
  assert.equal(w.errors[0].code, 'Incompatible');
});

test('reconnection uses a fresh authorized replacement and keeps its exact new boundary', async (t) => {
  const f = await fixture(t),
    original = fetch;
  let attempts = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const response = await original(url, init);
      if (!String(url).endsWith(P.streamPath) || ++attempts !== 1) return response;
      const reader = response.body!.getReader(),
        part = await reader.read();
      await reader.cancel();
      reader.releaseLock();
      return new Response(part.value, { headers: response.headers });
    },
  );
  const w = f.observe();
  await wait(() => w.views.some((v) => v.observationStatus === 'reconnecting'));
  f.publish({ ...snapshot, message: 'fresh view', transcriptBoundary: 'new-boundary' });
  await wait(
    () =>
      w.views.at(-1)?.message === 'fresh view' && w.views.at(-1)?.observationStatus === 'connected',
  );
  assert.equal(w.views.at(-1)!.transcriptBoundary, 'new-boundary');
  assert.equal(attempts, 2);
  assert.deepEqual(w.errors, []);
  await w.close();
});

test('a blocked writer has its own drain deadline and releases its watch while RPC remains usable', async (t) => {
  shortenDeadline(t, P.streamLimits.drainMs);
  const f = await fixture(t),
    original = ServerResponse.prototype.write;
  let writes = 0;
  t.mock.method(
    ServerResponse.prototype,
    'write',
    function (this: ServerResponse, ...args: Parameters<typeof original>) {
      if (
        this.getHeader('content-type') === 'application/vnd.moonbase.chat-stream-v1' &&
        ++writes > 1
      )
        return false;
      return original.apply(this, args);
    },
  );
  const w = f.observe();
  await wait(() => w.views.length === 1);
  f.publish({ ...snapshot, message: 'blocked' });
  assert((await f.client.command('getChatHost', { host })).features?.includes('chat-stream-v1'));
  await wait(() => w.errors.length === 1);
  await wait(() => f.listeners.size === 0);
  assert.equal(w.errors[0].code, 'Unavailable');
  assert.equal(f.acquisitions, f.releases);
});

test('network subscription capacity is independently enforced for raw authenticated clients', async (t) => {
  const f = await fixture(t),
    responses: Response[] = [];
  t.after(async () => {
    await Promise.all(responses.filter((r) => !r.bodyUsed).map((r) => r.body?.cancel()));
  });
  async function open() {
    const nonce = P.nonce(),
      grant = await fetch(f.origin + '/v1/chat/challenge', {
        headers: {
          'X-Moonbase-Nonce': nonce,
          Authorization: `Moonbase-RPC-HMAC-SHA256 ${P.mac(f.token, 'challenge-request', nonce, 'GET', '/v1/chat/challenge')}`,
        },
      });
    const { challenge } = (await grant.json()) as { challenge: string },
      body = JSON.stringify({ target, connectionId: 'raw' });
    const response = await fetch(f.origin + P.streamPath, {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'X-Moonbase-Nonce': nonce,
        'X-Moonbase-Challenge': challenge,
        Authorization: `Moonbase-RPC-HMAC-SHA256 ${P.streamMac(f.token, 'request', nonce, challenge, 'POST', P.streamPath, P.hash(body))}`,
      },
    });
    responses.push(response);
    return response;
  }
  for (let i = 0; i < 64; i++) assert.equal((await open()).status, 200);
  const extra = await open();
  assert.equal(extra.status, 400);
  const value = (await extra.json()) as { error: { code: string } };
  assert.equal(value.error.code, 'Unavailable');
  assert.equal(f.acquisitions, 64);
});

test('closing a network observation releases listeners while a held SDK capture stays owned until actual settlement', async (t) => {
  let harness!: Harness;
  const open = Harness.open;
  t.mock.method(Harness, 'open', async (...args: Parameters<typeof open>) => {
    harness = await open(...args);
    return harness;
  });
  const pi = await piFixture(t),
    target = await pi.create();
  const gate = Promise.withResolvers<void>();
  const commit = harness.commit.bind(harness);
  let held = false,
    watches = 0;
  t.mock.method(harness, 'commit', async (...args: Parameters<typeof commit>) => {
    const result = await commit(...args);
    if (!held && result && typeof result === 'object' && 'live' in result && 'boundary' in result) {
      held = true;
      await gate.promise;
    }
    return result;
  });
  const scope = Effect.runSync(Scope.make()),
    token = P.nonce();
  const server = await pi.runtime.runPromise(
    serveChat(
      { host: target.host, token, port: 0 },
      {
        command: pi.client.command,
        watch: (input, receive, error) => {
          watches++;
          const close = pi.client.watch(input, receive, error);
          return async () => {
            await close();
            watches--;
          };
        },
      },
    ).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  const unavailable = () =>
    Effect.fail(new ApplicationError({ code: 'Unavailable', message: 'Controlled' }));
  const connection = Layer.succeed(ConnectionService, {
    getConnection: unavailable,
    connect: unavailable,
    disconnect: unavailable,
    watch: () => Stream.empty,
    endpoint: () =>
      Effect.succeed({
        origin: server.origin,
        token,
        expected: target.host,
        connectionId: 'held',
        health: {
          ...target.host,
          protocol: 1 as const,
          version: '0.1.0' as const,
          capabilities: ['chat-v0'],
        },
      }),
  });
  const remote = ManagedRuntime.make(RemoteChatLive.pipe(Layer.provide(connection))),
    client = makeChatClient(remote),
    views: ChatSnapshot[] = [],
    errors: ApplicationError[] = [];
  const close = client.watch(
    { target },
    (v) => views.push(v),
    (e) => errors.push(e),
  );
  try {
    await wait(() => held);
    await close();
    await wait(() => watches === 0);
    await pi.create('unrelated-B');
    await pi.runtime.runPromise(Scope.close(scope, Exit.void));
    let disposed = false;
    const disposal = pi.dispose().then(() => {
      disposed = true;
    });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(disposed, false);
    gate.resolve();
    await disposal;
    assert.deepEqual(views, []);
    assert.deepEqual(errors, []);
  } finally {
    gate.resolve();
    await close();
    await remote.dispose();
    await pi.runtime.runPromise(Scope.close(scope, Exit.void)).catch(() => {});
  }
});

test('the remote adapter authenticates fragmented and coalesced frame bytes before publishing', async (t) => {
  const f = await fixture(t);
  interceptFrames(
    t,
    f.token,
    (frames, _, { nonce, challenge }) => {
      const decoder = new P.FrameDecoder(),
        first = [...decoder.push(frames[0])][0];
      const value = P.json(first.body) as ChatStreamFrame;
      const frame = P.encodeFrame(f.token, nonce, challenge, {
        target: value.target,
        connectionId: value.connectionId,
        streamId: value.streamId,
        kind: 'heartbeat',
        sequence: 1,
      });
      const bytes = Buffer.concat([frames[0], frame]);
      return [
        bytes.subarray(0, 1),
        bytes.subarray(1, 3),
        bytes.subarray(3, 35),
        bytes.subarray(35),
      ];
    },
    true,
  );
  const w = f.observe();
  await wait(() => w.views.length > 0);
  await w.close();
  assert.equal(w.views[0].conversation.target.conversationId, 'A');
  assert.equal(w.views.filter((v) => v.observationStatus === 'connected').length, 1);
  assert.deepEqual(w.errors, []);
});

test('reader cleanup failures remain observable and are not discarded by a transport retry', async (t) => {
  const f = await fixture(t),
    original = fetch;
  let releases = 0,
    attempts = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const response = await original(url, init);
      if (!String(url).endsWith(P.streamPath)) return response;
      attempts++;
      const source = response.body!.getReader(),
        part = await source.read();
      await source.cancel();
      source.releaseLock();
      const replacement = new Response(part.value, { headers: response.headers }),
        reader = replacement.body!.getReader();
      t.mock.method(reader, 'cancel', async () => {
        releases++;
        throw new ApplicationError({
          code: 'Persistence',
          message: 'Controlled reader release failure',
        });
      });
      t.mock.method(replacement.body!, 'getReader', () => reader);
      return replacement;
    },
  );
  const w = f.observe();
  await wait(() => w.errors.length > 0);
  assert.equal(attempts, 1);
  assert.equal(releases, 1);
  assert.match(w.errors[0].message, /Controlled reader release failure/);
  await assert.rejects(w.close());
});

test('a lost challenge body retries without treating its existing read error as a cleanup failure', async (t) => {
  const f = await fixture(t),
    original = fetch;
  let challenges = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const response = await original(url, init);
      if (!String(url).endsWith('/v1/chat/challenge') || challenges++ !== 1) return response;
      await response.body!.cancel();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(Error('Controlled lost challenge body'));
          },
        }),
        { headers: response.headers },
      );
    },
  );
  const w = f.observe();
  await wait(() => {
    if (w.errors.length) throw w.errors[0];
    return w.views.length > 0;
  });
  assert.equal(challenges, 3);
  assert.deepEqual(w.errors, []);
  assert.equal(f.acquisitions, 1);
  assert(!f.calls.includes('getChat'));
  await w.close();
});

test('a held public service consumer never dequeues a buffered snapshot after connection generation replacement', async (t) => {
  const f = await fixture(t),
    original = fetch,
    release = Promise.withResolvers<void>();
  let bufferedRead = false,
    bufferedQueued = false;
  t.mock.method(
    globalThis,
    'fetch',
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const response = await original(url, init);
      if (!String(url).endsWith(P.streamPath)) return response;
      const reader = response.body!.getReader(),
        read = reader.read.bind(reader),
        decoder = new P.FrameDecoder();
      t.mock.method(reader, 'read', async () => {
        if (bufferedRead) bufferedQueued = true;
        const part = await read();
        if (!part.done)
          for (const frame of decoder.push(part.value)) {
            const value = P.json(frame.body) as ChatStreamFrame;
            if (
              value.kind === 'snapshot' &&
              value.offset === 0 &&
              Buffer.from(value.data, 'base64').length === value.total
            ) {
              const snapshot = P.json(Buffer.from(value.data, 'base64')) as ChatSnapshot;
              if (snapshot.message === 'buffered in generation one') bufferedRead = true;
            }
          }
        return part;
      });
      t.mock.method(response.body!, 'getReader', () => reader);
      return response;
    },
  );
  const seen: ChatSnapshot[] = [];
  const completion = f.runtime.runPromiseExit(
    Effect.gen(function* () {
      const service = yield* ChatService;
      yield* service.watch({ target }).pipe(
        Stream.runForEach((value) => {
          seen.push(value);
          return seen.length === 1 ? Effect.promise(() => release.promise) : Effect.void;
        }),
      );
    }),
  );
  try {
    await wait(() => seen.length === 1);
    f.publish({
      ...snapshot,
      message: 'buffered in generation one',
      transcriptBoundary: 'old-boundary',
    });
    await wait(() => bufferedQueued);
    f.replace();
    await wait(() => f.replacementChecks > 0);
    release.resolve();
    const result = await completion;
    assert(Exit.isFailure(result));
    if (Exit.isFailure(result))
      assert(
        result.cause.reasons.some(
          (reason) =>
            'error' in reason &&
            ApplicationError.is(reason.error) &&
            reason.error.code === 'Unavailable',
        ),
      );
    assert.equal(
      seen.length,
      1,
      'generation-one queued content must not reach a generation-two consumer',
    );
    assert.deepEqual(seen[0].conversation.target, target);
    await wait(() => f.listeners.size === 0);
    assert.equal(f.acquisitions, f.releases);
  } finally {
    release.resolve();
    await completion;
  }
});

for (const reason of ['close', 'generation'] as const)
  test(`public watch ${reason} retains and awaits independent reader cleanup failure`, async (t) => {
    const f = await fixture(t),
      original = fetch,
      release = Promise.withResolvers<void>();
    let entered = false,
      cancellations = 0;
    t.mock.method(
      globalThis,
      'fetch',
      async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const response = await original(url, init);
        if (!String(url).endsWith(P.streamPath)) return response;
        const reader = response.body!.getReader(),
          cancel = reader.cancel.bind(reader);
        t.mock.method(reader, 'cancel', async () => {
          cancellations++;
          await cancel();
          entered = true;
          await release.promise;
          throw new ApplicationError({
            code: 'Persistence',
            message: 'Independent reader release failed',
          });
        });
        t.mock.method(response.body!, 'getReader', () => reader);
        return response;
      },
    );
    const w = f.observe();
    await wait(() => w.views.length === 1);
    let settled = false;
    const closing =
      reason === 'close'
        ? w.close().then(
            () => {
              settled = true;
              return undefined;
            },
            (error) => {
              settled = true;
              return error;
            },
          )
        : undefined;
    if (reason === 'generation') f.replace();
    try {
      await wait(() => entered);
      assert.equal(settled, false);
      assert.equal(w.errors.length, 0);
      assert(
        (await f.client.command('getChatHost', { host })).features?.includes('chat-stream-v1'),
      );
      release.resolve();
      if (reason === 'close') {
        const error = await closing;
        assert(ApplicationError.is(error));
        assert.equal(error.code, 'Persistence');
        assert.equal(error.message, 'Independent reader release failed');
      } else {
        await wait(() => w.errors.length === 1);
        assert.equal(w.errors[0].code, 'Unavailable');
        assert.match(w.errors[0].message, /generation changed/);
        assert.match(w.errors[0].message, /Independent reader release failed/);
        assert.equal(w.errors[0].message.match(/Independent reader release failed/g)?.length, 1);
        await assert.rejects(w.close(), /Independent reader release failed/);
      }
      assert.equal(cancellations, 1);
      await wait(() => f.listeners.size === 0);
      f.publish({ ...snapshot, message: 'late after failed release' });
      assert.equal(w.views.length, 1);
    } finally {
      release.resolve();
      await closing;
    }
  });

test('a reader cancellation repeating its transport error is not a second cleanup failure', async (t) => {
  const f = await fixture(t),
    original = fetch;
  let attempts = 0,
    cancellations = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const response = await original(url, init);
      if (!String(url).endsWith(P.streamPath)) return response;
      attempts++;
      const reader = response.body!.getReader(),
        read = reader.read.bind(reader),
        cancel = reader.cancel.bind(reader),
        failure = Error('private transport diagnostic');
      let initial = true;
      t.mock.method(reader, 'read', () => {
        if (initial) {
          initial = false;
          return read();
        }
        return Promise.reject(failure);
      });
      t.mock.method(reader, 'cancel', async () => {
        cancellations++;
        await cancel();
        throw failure;
      });
      t.mock.method(response.body!, 'getReader', () => reader);
      return response;
    },
  );
  const w = f.observe();
  await wait(() => w.errors.length === 1);
  assert.equal(attempts, 4);
  assert.equal(cancellations, 4);
  assert.equal(w.errors[0].code, 'Unavailable');
  assert.equal(w.errors[0].message, 'Chat stream was interrupted.');
  assert.equal(w.views.at(-1)!.observationStatus, 'reconnecting');
  await wait(() => f.listeners.size === 0);
});

for (const failure of ['initial', 'once', 'persistent'] as const)
  test(`production server delivers authenticated terminal source errors without reconnect (${failure})`, async (t) => {
    const f = await fixture(t, failure === 'initial'),
      w = f.observe();
    await wait(() => (failure === 'initial' ? f.acquisitions === 1 : w.views.length === 1));
    f.failSource(
      new ApplicationError({ code: 'Unauthorized', message: 'private source diagnostic' }),
      failure === 'persistent',
    );
    await wait(() => w.errors.length === 1 || (failure === 'once' && f.acquisitions > 1));
    assert.equal(w.errors[0]?.code, 'Unauthorized');
    assert.equal(w.errors[0].message, 'Chat request is not authorized.');
    assert.equal(f.acquisitions, 1);
    await wait(() => f.listeners.size === 0);
    assert.equal(f.releases, 1);
    if (failure === 'initial') assert.equal(w.views.length, 0);
    else assert.equal(w.views.at(-1)!.observationStatus, 'reconnecting');
    await assert.rejects(w.close(), { code: 'Unauthorized' });
  });

test(
  'a stalled terminal finish is bounded and releases its observation without blocking RPC',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t),
      nonce = P.nonce();
    const grant = await fetch(f.origin + '/v1/chat/challenge', {
      headers: {
        'X-Moonbase-Nonce': nonce,
        Authorization: `Moonbase-RPC-HMAC-SHA256 ${P.mac(f.token, 'challenge-request', nonce, 'GET', '/v1/chat/challenge')}`,
      },
    });
    const { challenge } = (await grant.json()) as { challenge: string },
      body = JSON.stringify({ target, connectionId: 'raw' });
    const response = await fetch(f.origin + P.streamPath, {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'X-Moonbase-Nonce': nonce,
        'X-Moonbase-Challenge': challenge,
        Authorization: `Moonbase-RPC-HMAC-SHA256 ${P.streamMac(f.token, 'request', nonce, challenge, 'POST', P.streamPath, P.hash(body))}`,
      },
    });
    const reader = response.body!.getReader();
    await reader.read();
    const entered = Promise.withResolvers<void>(),
      end = ServerResponse.prototype.end;
    t.mock.method(
      ServerResponse.prototype,
      'end',
      function (this: ServerResponse, ...args: Parameters<typeof end>) {
        if (this.getHeader('content-type') === 'application/vnd.moonbase.chat-stream-v1') {
          entered.resolve();
          return this;
        }
        return end.apply(this, args);
      },
    );
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      f.failSource(
        new ApplicationError({ code: 'Unauthorized', message: 'controlled source error' }),
      );
      await entered.promise;
      assert.equal(f.releases, 0);
      assert(
        (await f.client.command('getChatHost', { host })).features?.includes('chat-stream-v1'),
      );
      t.mock.timers.tick(P.streamLimits.drainMs - 1);
      assert.equal(f.releases, 0);
      t.mock.timers.tick(1);
      t.mock.timers.reset();
      await wait(() => f.releases === 1);
      assert.equal(f.listeners.size, 0);
    } finally {
      t.mock.timers.reset();
      try {
        await reader.cancel();
      } catch {
        /* The bounded finish deliberately destroys the unfinished response. */
      }
      reader.releaseLock();
    }
  },
);

test(
  'verified heartbeats keep the stream alive across production idle periods on a controlled clock',
  { timeout: 5000 },
  async (t) => {
    const original = fetch;
    let nextHeartbeat: { resolve: () => void; reject: (error: unknown) => void } | undefined;
    t.mock.method(
      globalThis,
      'fetch',
      async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const response = await original(url, init);
        if (!String(url).endsWith(P.streamPath)) return response;
        const reader = response.body!.getReader(),
          read = reader.read.bind(reader),
          decoder = new P.FrameDecoder();
        let heartbeat = false;
        t.mock.method(reader, 'read', async () => {
          // A subsequent read means the adapter has authenticated and processed this heartbeat.
          if (heartbeat) {
            heartbeat = false;
            nextHeartbeat?.resolve();
          }
          const part = await read();
          if (!part.done)
            for (const frame of decoder.push(part.value))
              if ((P.json(frame.body) as ChatStreamFrame).kind === 'heartbeat') heartbeat = true;
          return part;
        });
        t.mock.method(response.body!, 'getReader', () => reader);
        return response;
      },
    );
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const f = await fixture(t),
      initial = Promise.withResolvers<void>(),
      views: ChatSnapshot[] = [],
      errors: ApplicationError[] = [];
    const close = f.client.watch(
      { target },
      (value) => {
        views.push(value);
        initial.resolve();
        if (value.observationStatus !== 'connected')
          nextHeartbeat?.reject(Error('Healthy heartbeat stream became stale'));
      },
      (error) => {
        errors.push(error);
        initial.reject(error);
        nextHeartbeat?.reject(error);
      },
    );
    try {
      await initial.promise;
      for (let i = 0; i < 4; i++) {
        const consumed = Promise.withResolvers<void>();
        nextHeartbeat = consumed;
        t.mock.timers.tick(P.streamLimits.heartbeatMs);
        await consumed.promise;
        assert.equal(errors.length, 0);
      }
      assert.equal(views.length, 1);
      assert.equal(views[0].observationStatus, 'connected');
      assert(!f.calls.includes('getChat'));
    } finally {
      t.mock.timers.reset();
      await close();
    }
  },
);
