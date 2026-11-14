import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { Layer, ManagedRuntime } from 'effect';
import type { ChatClient, ChatTranscriptSource } from '@moonbase/contracts/chat';
import type { ConnectionClient } from '@moonbase/contracts/connection';
import { ChatIpcSession, transcriptImageTokenLifetime } from '../src/main/chat/session.ts';
import { respondTranscriptImage } from '../src/main/chat/transcript-native.ts';

const runtime = ManagedRuntime.make(Layer.empty);
after(() => runtime.dispose());
const context = { host: { hostId: 'host', storeId: 'store' }, actorId: 'actor' };
const source: ChatTranscriptSource = {
  kind: 'entry',
  target: { ...context, conversationId: 'chat' },
  entryId: 'entry',
};
const png = readFileSync(new URL('./fixtures/images/checker.png', import.meta.url));
const jpeg = readFileSync(new URL('./fixtures/images/retained.jpg', import.meta.url));
const csp = "default-src 'none'; img-src 'self' data:";

function fixture(
  bytes: Buffer,
  options: {
    perf?: { now(): number };
    connection?: ConnectionClient;
    /** Holds unrelated chat commands so they occupy request capacity. */
    commands?: Promise<void>;
  } = {},
) {
  const selection = {
    partId: 'image',
    bytes: bytes.length,
    revision: createHash('sha256').update(bytes).digest('hex'),
  };
  const signals: AbortSignal[] = [];
  let reads = 0,
    hold: Promise<void> | undefined;
  // Trusted ChatClient: chunks past the selected size are rejected at the ChatClient boundary.
  const chat: ChatClient = {
    watchChatList: () => async () => {},
    async command(operation, input, commandOptions) {
      if (operation === 'getChat') {
        await options.commands;
        return null as never;
      }
      assert.equal(operation, 'getChatTranscriptContent');
      reads++;
      signals.push(commandOptions!.signal!);
      await hold;
      const offset = Number((input as { cursor?: string }).cursor ?? 0),
        end = Math.min(offset + 256, bytes.length);
      return {
        kind: 'content',
        source,
        selection: (input as { selection: typeof selection }).selection,
        cursor: offset ? String(offset) : null,
        offset,
        encoding: 'base64',
        data: bytes.subarray(offset, end).toString('base64'),
        nextCursor: end < bytes.length ? String(end) : null,
      } as never;
    },
    watch: () => () => Promise.resolve(),
  };
  const session = new ChatIpcSession(
    runtime,
    chat,
    options.connection ? { mode: 'remote', connection: options.connection } : { mode: 'local' },
    context,
    () => {},
    {
      perf: options.perf,
    },
  );
  let id = 0;
  const issue = async (mimeType: string, value = selection) => {
    const reply = await session.call(
      'transcript',
      'image',
      { source, selection: value, mimeType },
      `issue-${id++}`,
    );
    assert(reply.ok);
    return reply.value as string;
  };
  const serve = (url: string, signal?: AbortSignal, method = 'GET') =>
    respondTranscriptImage(new Request(url, { signal, method }), csp, (token) =>
      session.findImage(token),
    );
  return {
    session,
    issue,
    serve,
    selection,
    signals,
    get reads() {
      return reads;
    },
    hold(promise: Promise<void>) {
      hold = promise;
    },
  };
}

test('an issued token serves validated PNG and JPEG bytes with fixed security headers', async () => {
  for (const [bytes, mimeType] of [
    [png, 'image/png'],
    [jpeg, 'image/jpeg'],
  ] as const) {
    const f = fixture(bytes);
    const url = await f.issue(mimeType);
    assert.match(url, /^moonbase:\/\/editor\/transcript-image\/[A-Za-z0-9_-]{43}$/);
    assert.equal(await f.issue(mimeType), url, 'equal bindings reuse one token');
    const response = await f.serve(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), mimeType);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('Content-Security-Policy'), csp);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert(f.reads > 1, 'multiple independently padded chunks');
    await f.session.dispose();
  }
});

test('unknown, revoked and wrong-host image URLs grant nothing', async () => {
  const f = fixture(png);
  const url = await f.issue('image/png');
  const token = url.slice(url.lastIndexOf('/') + 1);
  assert.equal((await f.serve('moonbase://editor/transcript-image/unknown')).status, 404);
  assert.equal((await f.serve(`moonbase://other/transcript-image/${token}`)).status, 403);
  assert.equal((await f.serve(`${url}?retry`)).status, 403);
  for (const method of ['HEAD', 'POST'])
    assert.equal((await f.serve(url, undefined, method)).status, 405);
  await f.session.dispose();
  assert.equal((await f.serve(url)).status, 404);
  await assert.rejects(f.issue('image/png'), { code: 'InvalidInput' });
  assert.equal(f.reads, 0);
});

test('an unrequested token expires while each request extends its lifetime', async () => {
  let now = 1000;
  const f = fixture(png, { perf: { now: () => now } });
  const url = await f.issue('image/png');
  now += transcriptImageTokenLifetime - 1;
  assert.equal((await f.serve(url)).status, 200, 'a request refreshes the binding');
  now += transcriptImageTokenLifetime - 1;
  assert.equal(await f.issue('image/png'), url, 'reissuing refreshes the binding');
  now += transcriptImageTokenLifetime + 1;
  assert.equal((await f.serve(url)).status, 404);
  const replacement = await f.issue('image/png');
  assert.notEqual(replacement, url, 'an expired binding is never revived');
  assert.equal((await f.serve(replacement)).status, 200);
  await f.session.dispose();
});

test('connecting or disconnecting revokes issued tokens', async () => {
  const operations: string[] = [];
  const connection: ConnectionClient = {
    command: async (operation) => {
      operations.push(operation);
      return (operation === 'disconnect' ? undefined : { state: 'disconnected' }) as never;
    },
    watch: () => async () => {},
  };
  const f = fixture(png, { connection });
  const url = await f.issue('image/png');
  assert((await f.session.call('connection', 'getConnection', {}, 'status')).ok);
  assert.equal((await f.serve(url)).status, 200, 'reading status keeps tokens');
  for (const [operation, input] of [
    ['disconnect', { connectionId: 'connection' }],
    ['connect', { profileId: 'profile' }],
  ] as const) {
    const issued = await f.issue('image/png');
    assert((await f.session.call('connection', operation, input, operation)).ok);
    assert.equal((await f.serve(issued)).status, 404);
  }
  assert.deepEqual(operations, ['getConnection', 'disconnect', 'connect']);
  await f.session.dispose();
});

test('a token issued while connect is held is revoked once connect settles', async () => {
  const gate = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  const connection: ConnectionClient = {
    command: async () => {
      entered.resolve();
      await gate.promise;
      return { state: 'connected' } as never;
    },
    watch: () => async () => {},
  };
  const f = fixture(png, { connection });
  const connecting = f.session.call('connection', 'connect', { profileId: 'profile' }, 'connect');
  await entered.promise;
  const issued = await f.issue('image/png');
  gate.resolve();
  assert((await connecting).ok);
  assert.equal((await f.serve(issued)).status, 404);
  assert.equal(f.reads, 0);
  await f.session.dispose();
});

test('revocation fails queued reads and cancels in-flight ones', async () => {
  const connection: ConnectionClient = {
    command: async () => undefined as never,
    watch: () => async () => {},
  };
  const f = fixture(png, { connection });
  const urls = await Promise.all(
    Array.from({ length: 7 }, (_, index) =>
      f.issue('image/png', { ...f.selection, partId: `image-${index}` }),
    ),
  );
  const gate = Promise.withResolvers<void>();
  f.hold(gate.promise);
  const running = urls.slice(0, 6).map((url) => f.serve(url));
  while (f.reads < 6) await new Promise((resolve) => setImmediate(resolve));
  const queued = f.serve(urls[6]!);
  await new Promise((resolve) => setImmediate(resolve));
  assert(
    (await f.session.call('connection', 'disconnect', { connectionId: 'c' }, 'disconnect')).ok,
  );
  assert.equal((await queued).status, 502);
  assert(f.signals.every((signal) => signal.aborted));
  gate.resolve();
  for (const response of await Promise.all(running)) assert.equal(response.status, 502);
  assert.equal(f.reads, 6);
  assert.equal(f.session.count, 0);
  await f.session.dispose();
});

test('the image read queue is bounded and refuses overflow as busy', async () => {
  const f = fixture(png);
  const urls = await Promise.all(
    Array.from({ length: 6 + 64 + 1 }, (_, index) =>
      f.issue('image/png', { ...f.selection, partId: `image-${index}` }),
    ),
  );
  const gate = Promise.withResolvers<void>();
  f.hold(gate.promise);
  const running = urls.slice(0, 6).map((url) => f.serve(url));
  while (f.reads < 6) await new Promise((resolve) => setImmediate(resolve));
  const queued = urls.slice(6, 70).map((url) => f.serve(url));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await f.serve(urls[70]!)).status, 502);
  assert.equal(f.reads, 6);
  gate.resolve();
  for (const response of await Promise.all([...running, ...queued]))
    assert.equal(response.status, 200);
  await f.session.dispose();
});

test('a read slot is released when the session request limit is full', async () => {
  const commands = Promise.withResolvers<void>();
  const f = fixture(png, { commands: commands.promise });
  const url = await f.issue('image/png');
  const target = { ...context, conversationId: 'chat' };
  const held = Array.from({ length: 64 }, (_, index) =>
    f.session.call('chat', 'getChat', { target }, `held-${index}`),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.session.count, 64);
  for (let attempt = 0; attempt < 7; attempt++)
    assert.equal((await f.serve(url)).status, 502, 'Image reads are busy');
  assert.equal(f.reads, 0);
  commands.resolve();
  for (const reply of await Promise.all(held)) assert(reply.ok);
  assert.equal((await f.serve(url)).status, 200, 'every refused read released its slot');
  await f.session.dispose();
});

test('reads beyond the concurrency limit queue instead of failing', async () => {
  const f = fixture(png);
  const urls = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      f.issue('image/png', { ...f.selection, partId: `image-${index}` }),
    ),
  );
  const gate = Promise.withResolvers<void>();
  f.hold(gate.promise);
  const responses = Promise.all(urls.map((url) => f.serve(url)));
  while (f.reads < 6) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.reads, 6, 'two reads wait for a slot');
  assert.equal(f.session.count, 6);
  gate.resolve();
  for (const response of await responses) assert.equal(response.status, 200);
  assert.equal(f.session.count, 0);
  await f.session.dispose();
});

test('an aborted queued read leaves without reading and frees no extra slot', async () => {
  const f = fixture(png);
  const urls = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      f.issue('image/png', { ...f.selection, partId: `image-${index}` }),
    ),
  );
  const gate = Promise.withResolvers<void>();
  f.hold(gate.promise);
  const abort = new AbortController();
  const running = urls.slice(0, 6).map((url) => f.serve(url));
  while (f.reads < 6) await new Promise((resolve) => setImmediate(resolve));
  const queued = f.serve(urls[6]!, abort.signal),
    later = f.serve(urls[7]!);
  abort.abort();
  assert.equal((await queued).status, 502);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.reads, 6, 'neither queued read started');
  gate.resolve();
  for (const response of await Promise.all([...running, later])) assert.equal(response.status, 200);
  assert.equal(f.session.count, 0);
  await f.session.dispose();
});

test('disposal fails queued reads and cancels in-flight ones', async () => {
  const f = fixture(png);
  const urls = await Promise.all(
    Array.from({ length: 7 }, (_, index) =>
      f.issue('image/png', { ...f.selection, partId: `image-${index}` }),
    ),
  );
  const gate = Promise.withResolvers<void>();
  f.hold(gate.promise);
  const running = urls.slice(0, 6).map((url) => f.serve(url));
  while (f.reads < 6) await new Promise((resolve) => setImmediate(resolve));
  const queued = f.serve(urls[6]!);
  await new Promise((resolve) => setImmediate(resolve));
  const disposing = f.session.dispose();
  assert.equal((await queued).status, 502);
  gate.resolve();
  for (const response of await Promise.all(running)) assert.equal(response.status, 502);
  await disposing;
  assert.equal(f.reads, 6);
  assert(f.signals.every((signal) => signal.aborted));
  assert.equal(f.session.count, 0);
});

test('the 256-token cap evicts the least recently requested binding', async () => {
  const f = fixture(png);
  const first = await f.issue('image/png');
  const second = await f.issue('image/png', { ...f.selection, partId: 'image-0' });
  for (let index = 1; index < 255; index++)
    await f.issue('image/png', { ...f.selection, partId: `image-${index}` });
  assert.equal(await f.issue('image/png'), first, 'reuse refreshes the first binding');
  await f.issue('image/png', { ...f.selection, partId: 'image-overflow' });
  assert.equal((await f.serve(second)).status, 404);
  assert.equal((await f.serve(first)).status, 200);
  await f.session.dispose();
});

test('issuance rejects SVG/HTML types and foreign authority before any read', async () => {
  const f = fixture(png);
  for (const mimeType of ['image/svg+xml', 'text/html', 'image/gif'])
    await assert.rejects(
      f.session.call(
        'transcript',
        'image',
        { source, selection: f.selection, mimeType },
        `bad-${mimeType}`,
      ),
      { code: 'InvalidInput' },
    );
  await assert.rejects(
    f.session.call(
      'transcript',
      'image',
      {
        source: { ...source, target: { ...source.target, actorId: 'foreign' } },
        selection: f.selection,
        mimeType: 'image/png',
      },
      'foreign',
    ),
    { code: 'Unauthorized' },
  );
  assert.equal(f.reads, 0);
  await f.session.dispose();
});

test('bytes must match the declared raster type; SVG labelled PNG is refused', async () => {
  for (const [bytes, mimeType] of [
    [png, 'image/jpeg'],
    [jpeg, 'image/png'],
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'image/png'],
    [Buffer.from('<html><script>alert(1)</script></html>'), 'image/jpeg'],
  ] as const) {
    const f = fixture(bytes);
    const response = await f.serve(await f.issue(mimeType));
    assert.equal(response.status, 415);
    assert.equal(response.headers.get('Content-Type'), 'text/plain; charset=utf-8');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    await f.session.dispose();
  }
});

test('sources over 4 MiB are refused without reading', async () => {
  const f = fixture(png);
  const url = await f.issue('image/png', { ...f.selection, bytes: 4 * 1024 * 1024 + 1 });
  const response = await f.serve(url);
  assert.equal(response.status, 413);
  assert.match(await response.text(), /4 MiB/);
  assert.equal(f.reads, 0);
  await f.session.dispose();
});

test('a cancelled request aborts its read and releases the session request', async () => {
  const f = fixture(png);
  const url = await f.issue('image/png');
  const gate = Promise.withResolvers<void>();
  f.hold(gate.promise);
  const abort = new AbortController();
  const pending = f.serve(url, abort.signal);
  while (!f.reads) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.session.count, 1);
  abort.abort();
  assert.equal(f.signals[0]!.aborted, true);
  // The response still joins the actual held IO before the request is released.
  gate.resolve();
  assert.equal((await pending).status, 502);
  assert.equal(f.session.count, 0);
  f.hold(Promise.resolve());
  assert.equal((await f.serve(url)).status, 200, 'the token remains valid for a later request');
  await f.session.dispose();
});

test('disposal cancels an in-flight read and revokes its token', async () => {
  const f = fixture(png);
  const url = await f.issue('image/png');
  const gate = Promise.withResolvers<void>();
  f.hold(gate.promise);
  const pending = f.serve(url);
  while (!f.reads) await new Promise((resolve) => setImmediate(resolve));
  const released = f.session.dispose();
  gate.resolve();
  assert.equal((await pending).status, 502);
  await released;
  assert.equal(f.signals[0]!.aborted, true);
  assert.equal((await f.serve(url)).status, 404);
});
