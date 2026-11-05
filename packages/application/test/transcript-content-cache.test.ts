import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TranscriptViewMemory, transcriptLimits } from '@moonbase/application/chat';
import type { ChatInput, ChatTranscriptSource } from '@moonbase/contracts/chat';
import { part, tick, transcriptController } from './transcript-fixture.ts';

const chunkBytes = 32 * 1024;
const serialized = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** Serves ASCII parts sized in 32 KiB chunks, optionally holding one exact cursor. */
async function largeParts(t: Parameters<typeof transcriptController>[0], sizes: number[]) {
  const f = await transcriptController(t, 1);
  const source = f.entries[0].transcript!.source as ChatTranscriptSource;
  const data = sizes.map((chunks, index) =>
    String.fromCharCode(97 + index).repeat(Math.ceil(chunks * chunkBytes)),
  );
  f.fixture.sources.set(JSON.stringify(source), { source, data });
  const held = new Map<string, Promise<void>>();
  f.handlers.set('getChatTranscriptContent', async (raw) => {
    const request = raw as ChatInput<'getChatTranscriptContent'>;
    const offset = Number(request.cursor ?? 0),
      text = data[Number(request.selection!.partId.slice(4))],
      end = Math.min(text.length, offset + chunkBytes);
    await held.get(`${request.selection!.partId}@${offset}`);
    return {
      kind: 'content',
      source,
      selection: request.selection,
      cursor: request.cursor ?? null,
      offset,
      data: text.slice(offset, end),
      encoding: 'utf8',
      nextCursor: end < text.length ? String(end) : null,
    };
  });
  const selection = (index: number) => {
    const value = part('m0.b' + index, data[index]);
    return { partId: value.partId, bytes: value.bytes, revision: value.revision };
  };
  const load = (index: number) => f.controller.loadTranscriptPart(source, selection(index));
  const loadAll = async (index: number) => {
    for (let chunk = 0; chunk < Math.ceil(sizes[index]); chunk++) await load(index);
  };
  const content = (index: number) =>
    f.controller
      .getSnapshot()
      .transcript.content.find((value) => value.selection.partId === 'm0.b' + index)!;
  return { f, held, load, loadAll, content };
}

function assertReportedUsage(f: Awaited<ReturnType<typeof transcriptController>>) {
  const transcript = f.controller.getSnapshot().transcript;
  assert.equal(transcript.retained.contentBytes, serialized(transcript.content));
  assert(transcript.retained.contentBytes <= transcriptLimits.contentBytes);
}

test('content eviction trims least-recently read prefixes first; chunk and status updates keep recency', async (t) => {
  // a, b and c fill 5.6 MiB; d adds 4.5 MiB, so b empties and c loses its oldest chunks.
  const { f, held, load, loadAll, content } = await largeParts(t, [60, 60, 60, 144]);
  await loadAll(0);
  await loadAll(1);
  for (let chunk = 0; chunk < 59; chunk++) await load(2);
  assertReportedUsage(f);
  // c's final chunk lands after a is read again; that update must not make c newer than a.
  const release = Promise.withResolvers<void>();
  held.set(`m0.b2@${59 * chunkBytes}`, release.promise);
  const finishing = load(2);
  await tick();
  await load(0);
  release.resolve();
  await finishing;
  assert.equal(content(2).status, 'complete');
  assert.deepEqual(
    f.controller.getSnapshot().transcript.content.map((value) => value.selection.partId),
    ['m0.b1', 'm0.b2', 'm0.b0'],
  );
  for (let chunk = 0; chunk < 144; chunk++) {
    await load(3);
    assertReportedUsage(f);
  }
  const b = content(1),
    c = content(2);
  assert.equal(b.chunks.length, 0);
  assert.equal(b.retainedFrom, b.loadedBytes);
  assert.equal(c.retainedFrom, 11 * chunkBytes);
  assert.equal(c.chunks[0].offset, c.retainedFrom);
  assert.equal(content(0).retainedFrom, 0);
  assert.equal(content(3).retainedFrom, 0);
  assert.equal(content(3).status, 'complete');
});

test('reported content usage stays exact through one oversized part and disposal', async (t) => {
  const { f, loadAll, content } = await largeParts(t, [288]);
  await loadAll(0);
  assertReportedUsage(f);
  assert.equal(content(0).retainedFrom, 35 * chunkBytes);
  assert.equal(content(0).loadedBytes, 288 * chunkBytes);
  await f.controller.loadTranscriptPart(content(0).source, content(0).selection, true);
  assertReportedUsage(f);
  assert.equal(content(0).chunks.length, 1);
  await f.controller.detach();
  assert.deepEqual(f.controller.getSnapshot().transcript.content, []);
});

test('one publication measures only the selection it changed', async (t) => {
  const { f, load, loadAll } = await largeParts(t, [120, 0.01, 0.01]);
  await loadAll(0);
  await load(1);
  const stringify = t.mock.method(JSON, 'stringify');
  await load(2);
  stringify.mock.restore();
  const untouched = (value: unknown): boolean =>
    Array.isArray(value)
      ? value.some(untouched)
      : (value as { selection?: { partId?: string } } | null)?.selection?.partId === 'm0.b0';
  assert(
    !stringify.mock.calls.some((call) => untouched(call.arguments[0])),
    'untouched retained content is not reserialized',
  );
  const bytes = stringify.mock.calls.reduce((total, call) => total + (call.result?.length ?? 0), 0);
  assert(bytes < chunkBytes, `serialized ${bytes} bytes for one small chunk`);
  assertReportedUsage(f);
});

test('view memory keeps the former recency and byte budget', () => {
  const memory = new TranscriptViewMemory();
  const target = (index: number) => ({
    host: { kind: 'local' as const, hostId: 'host', storeId: 'store' },
    actorId: 'actor',
    conversationId: 'conversation-' + index,
  });
  const expanded = (index: number) =>
    Array.from({ length: 128 }, (_, id) => `${index}-${id}-`.padEnd(250, 'x'));
  for (let index = 0; index < 6; index++)
    memory.set('backend', target(index), { anchor: null, expanded: expanded(index) });
  assert.equal(memory.get('backend', target(0)).expanded.length, 128);
  for (let index = 6; index < 10; index++)
    memory.set('backend', target(index), { anchor: null, expanded: expanded(index) });
  assert.deepEqual(
    Array.from(
      { length: 10 },
      (_, index) => memory.get('backend', target(index)).expanded.length > 0,
    ),
    [true, false, false, true, true, true, true, true, true, true],
  );
  memory.clear();
  assert.deepEqual(memory.get('backend', target(9)), { anchor: null, expanded: [] });
});
