import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { Layer, ManagedRuntime } from 'effect';
import type { ChatClient, ChatTranscriptSource } from '@moonbase/contracts/chat';
import { ChatIpcSession } from '../src/chat/session.ts';
import { respondTranscriptImage } from '../src/chat/transcript-native.ts';

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

function fixture(bytes: Buffer) {
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
    async command(operation, input, options) {
      assert.equal(operation, 'getChatTranscriptContent');
      reads++;
      signals.push(options!.signal!);
      await hold;
      const offset = Number((input as { cursor?: string }).cursor ?? 0),
        end = Math.min(offset + 256, bytes.length);
      return {
        kind: 'content',
        source,
        selection,
        cursor: offset ? String(offset) : null,
        offset,
        encoding: 'base64',
        data: bytes.subarray(offset, end).toString('base64'),
        nextCursor: end < bytes.length ? String(end) : null,
      } as never;
    },
    watch: () => () => Promise.resolve(),
  };
  const session = new ChatIpcSession(runtime, chat, null, context, () => {});
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
  await f.session.releaseDocument();
  assert.equal((await f.serve(url)).status, 404);
  const replacement = await f.issue('image/png');
  assert.notEqual(replacement, url);
  await f.session.dispose();
  assert.equal((await f.serve(replacement)).status, 404);
  assert.equal(f.reads, 0);
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

test('document release cancels an in-flight read and revokes its token', async () => {
  const f = fixture(png);
  const url = await f.issue('image/png');
  const gate = Promise.withResolvers<void>();
  f.hold(gate.promise);
  const pending = f.serve(url);
  while (!f.reads) await new Promise((resolve) => setImmediate(resolve));
  const released = f.session.releaseDocument();
  gate.resolve();
  assert.equal((await pending).status, 502);
  await released;
  assert.equal(f.signals[0]!.aborted, true);
  assert.equal((await f.serve(url)).status, 404);
  await f.session.dispose();
});
