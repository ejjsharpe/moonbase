import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApplicationError } from '@moonbase/contracts/errors';
import {
  iterateTranscriptSource,
  makeTranscriptReader,
  defaultTranscriptLimits,
} from '@moonbase/application/chat';
import { maximumChatReplyBytes } from '@moonbase/contracts/chat';
import type { ChatSnapshot, ChatTranscriptSource } from '@moonbase/contracts/chat';
import type { TranscriptLimits, TranscriptState } from '@moonbase/application/chat';
import {
  digest,
  part,
  scaledTranscriptLimits,
  selection,
  tick,
  transcriptHarness,
  transcriptFixture,
  until,
  type ContentReply,
  type TranscriptHarness,
} from './transcript-fixture.ts';

async function collect(iterator: AsyncIterable<{ data: string }>) {
  let text = '';
  for await (const chunk of iterator) text += chunk.data;
  return text;
}
const serialized = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
/** Published summaries and content stay within their budgets. */
function assertBounds(state: TranscriptState, limits: TranscriptLimits = defaultTranscriptLimits) {
  assert(state.entries.length + (state.manifest?.parts.length ?? 0) <= limits.summaryRecords);
  assert(serialized({ entries: state.entries, manifest: state.manifest }) <= limits.summaryBytes);
  assert(
    state.content.reduce((total, content) => total + serialized(content), 0) <= limits.contentBytes,
  );
}
function live(
  snapshot: ChatSnapshot,
  text: string,
  incarnation = digest('incarnation'),
): ChatSnapshot {
  const target = snapshot.conversation.target;
  return {
    ...snapshot,
    state: 'running',
    observationStatus: 'connected',
    run: {
      stop: { target, submissionId: 'send', taskId: 'task' },
      state: 'running',
      text,
      truncated: false,
      transcript: {
        source: {
          kind: 'live',
          target,
          submissionId: 'send',
          taskId: 'task',
          attempt: 0,
          incarnation,
        },
        parts: [part('m0.b0', text)],
        thinking: 'none',
        nextCursor: null,
      },
    },
  };
}

test('canonical history traverses >2 overlapping pages, both continuations, eviction and around restoration without text deduplication', async (t) => {
  const f = await transcriptHarness(t, 300, { limits: scaledTranscriptLimits });
  const seen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const state = f.state;
    state.entries.forEach((entry) => seen.add(entry.id));
    assertBounds(state, f.limits);
    assert.deepEqual(
      state.entries.map((entry) => Number(entry.id.slice(1))),
      state.entries.map((entry) => Number(entry.id.slice(1))).sort((a, b) => a - b),
    );
    if (!state.earlier) break;
    await f.transcript.showEarlier();
    assert.equal(f.state.error, null);
  }
  assert.equal(seen.size, 300);
  assert.equal(f.state.entries[0].id, 'e0');
  // Retained history needs no read to show an entry; evicted history reads around it.
  const arounds = () => f.calls.filter((call) => call.operation === 'getChatHistoryAround').length;
  let reads = arounds();
  await f.transcript.jumpToEntry('e40');
  assert.equal(arounds(), reads);
  await f.transcript.jumpToEntry('e200');
  assert.equal(arounds(), reads + 1);
  let state = f.state;
  assert(state.entries.some((entry) => entry.id === 'e200'));
  assert(state.earlier && state.later);
  await f.transcript.showEarlier();
  await f.transcript.showLater();
  state = f.state;
  assert(state.entries.some((entry) => entry.id === 'e200'));
  await f.publish({
    ...f.snapshot,
    state: 'running',
    message: 'latest changed',
  });
  assert.equal(f.state.entries, state.entries, 'live state does not replace historical window');
  await f.transcript.jumpToLatest();
  assert.equal(f.state.entries.at(-1)?.id, 'e299');
  reads = arounds();
  assert(reads > 2);
});

test('cloned live-only DTOs preserve summary/part/cache identity and unrelated replacements publish nothing', async (t) => {
  const f = await transcriptHarness(t, 40);
  const entry = f.state.entries[0],
    source = entry.transcript!.source,
    chosen = selection(entry.transcript!.parts[0]);
  await f.transcript.loadPart(source, chosen);
  await f.transcript.loadManifest(source);
  const cache = f.state.content[0];
  let value = live(f.snapshot, 'one');
  f.sources.set(JSON.stringify(value.run!.transcript!.source), {
    source: value.run!.transcript!.source,
    data: ['one'],
  });
  await f.publish(value);
  const stableEntry = f.state.entries[0];
  const stablePart = stableEntry.transcript!.parts[0];
  const calls = f.calls.length;
  for (let i = 0; i < 8; i++) {
    value = live(value, 'progress ' + i);
    await f.publish(value);
  }
  assert.equal(f.state.entries[0], stableEntry);
  assert.equal(f.state.entries[0].transcript!.parts[0], stablePart);
  assert.equal(f.state.content[0], cache);
  assert.equal(f.calls.length, calls);
  const before = f.state,
    publications = f.publications;
  await f.publish(structuredClone(value));
  assert.equal(f.state, before);
  assert.equal(f.publications, publications);
  await f.transcript.fail(
    new ApplicationError({
      code: 'Unauthorized',
      message: 'authority revoked',
    }),
  );
  assert.equal(f.state.observation, 'failed');
  assert.equal(f.state.error, 'authority revoked');
  assert.equal(await f.transcript.failed(), true);
  assert(f.publications > publications);
});

test("Load more parts reads a source's first manifest page and then its next, but not past a failed one", async (t) => {
  const f = await transcriptHarness(t, 2);
  const [first, second] = [f.entries[0], f.entries[1]].map((entry) => entry.transcript!.source);
  f.sources.set(JSON.stringify(first), {
    source: first,
    data: Array.from({ length: 70 }, (_, i) => 'part-' + i),
  });
  await f.transcript.loadMoreParts(first);
  assert.equal(f.state.manifest!.parts.length, 64, 'its first page, then the next');
  await f.transcript.loadMoreParts(first);
  assert.equal(f.state.manifest!.parts.length, 70);
  // Another row's source replaces the manifest; its failed first page is not read again at once.
  let reads = 0;
  f.handlers.set('getChatTranscriptContent', async () => {
    reads++;
    throw new ApplicationError({ code: 'Unavailable', message: 'held network failed' });
  });
  await f.transcript.loadMoreParts(second);
  assert.equal(reads, 1);
  assert.equal(f.state.manifest!.status, 'error');
});

test('selected manifest hydration advances and retries errors; content validates exact echoes and offsets', async (t) => {
  const f = await transcriptHarness(t, 1);
  const source = f.entries[0].transcript!.source;
  f.sources.set(JSON.stringify(source), {
    source,
    data: Array.from({ length: 70 }, (_, i) => 'part-' + i),
  });
  await f.transcript.loadManifest(source);
  assert.equal(f.state.manifest!.parts.length, 32);
  f.handlers.set('getChatTranscriptContent', async () => {
    throw new ApplicationError({
      code: 'Unavailable',
      message: 'held network failed',
    });
  });
  await f.transcript.loadManifest(source);
  assert.equal(f.state.manifest!.status, 'error');
  assert.equal(f.state.manifest!.nextCursor, '32');
  f.handlers.clear();
  await f.transcript.loadManifest(source);
  await f.transcript.loadManifest(source);
  assert.equal(f.state.manifest!.parts.length, 70);
  assert.equal(f.state.manifest!.status, 'complete');
  const data = 'x'.repeat(70000),
    chosen = selection(part('m0.b0', data));
  f.sources.set(JSON.stringify(source), { source, data: [data] });
  await f.transcript.loadPart(source, chosen);
  assert.equal(f.state.content[0].loadedBytes, 32768);
  // A short terminal chunk is rejected by the ChatClient boundary's reply schema.
  for (const corrupt of ['offset', 'target', 'revision'] as const) {
    f.handlers.set('getChatTranscriptContent', async (_input, _signal, fallback) => {
      const reply = structuredClone(fallback()) as ContentReply;
      if (corrupt === 'offset') reply.offset--;
      if (corrupt === 'target') reply.source.target.actorId = 'foreign';
      if (corrupt === 'revision') reply.selection.revision = digest('foreign');
      return reply;
    });
    await f.transcript.loadPart(source, chosen);
    assert.equal(f.state.content[0].status, 'error', corrupt);
    assert.equal(f.state.content[0].loadedBytes, 32768, corrupt);
  }
  f.handlers.clear();
  await f.transcript.loadPart(source, chosen);
  await f.transcript.loadPart(source, chosen);
  assert.equal(f.state.content[0].status, 'complete');
  assert.equal(f.state.content[0].chunks.map((chunk) => chunk.data).join(''), data);
});

test('one oversized part stays incrementally readable within the LRU; complete-source iteration is independent of cache', async (t) => {
  const f = await transcriptHarness(t, 1, { limits: scaledTranscriptLimits });
  const source = f.entries[0].transcript!.source,
    data = 'a'.repeat((9 * 1024 * 1024) / 8),
    chosen = selection(part('m0.b0', data));
  f.sources.set(JSON.stringify(source), { source, data: [data] });
  for (let i = 0; i < Math.ceil(data.length / 32768); i++)
    await f.transcript.loadPart(source, chosen);
  const view = f.state;
  assertBounds(view, f.limits);
  assert(view.content[0].retainedFrom > 0, 'oversized active selection is not exempt from budget');
  assert.equal(view.content[0].loadedBytes, data.length);
  assert.equal(
    await collect(
      iterateTranscriptSource({
        read: makeTranscriptReader(f.chat),
        source,
        selection: chosen,
      }),
    ),
    data,
  );
});

test('summary byte and record budgets include hydrated descriptors and envelopes; complete iteration passes descriptor eviction', async (t) => {
  const f = await transcriptHarness(t, 1, { limits: scaledTranscriptLimits });
  const source = f.entries[0].transcript!.source,
    data = Array.from({ length: f.limits.summaryRecords + 8 }, () => 'b'.repeat(256));
  f.sources.set(JSON.stringify(source), { source, data });
  for (let i = 0; i < data.length / 32 + 1; i++) await f.transcript.loadManifest(source);
  const state = f.state;
  assertBounds(state, f.limits);
  assert(state.manifest!.omittedParts > 0);
  assert.equal(
    await collect(iterateTranscriptSource({ read: makeTranscriptReader(f.chat), source })),
    data.join(''),
  );
});

test('closing the transcript aborts a held read at once, and its late reply never lands', async (t) => {
  const f = await transcriptHarness(t, 40);
  const source = f.entries[0].transcript!.source,
    chosen = selection(f.entries[0].transcript!.parts[0]);
  const entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<void>();
  f.handlers.set('getChatTranscriptContent', async (_input, _signal, fallback) => {
    entered.resolve();
    await held.promise;
    return fallback();
  });
  try {
    const read = f.transcript.loadPart(source, chosen);
    await entered.promise;
    // Closing does not wait for the host to answer the cancelled read.
    await f.close();
    await read;
    assert(f.calls.find((call) => call.operation === 'getChatTranscriptContent')!.signal!.aborted);
    held.resolve();
    await tick();
    assert.notEqual(f.state.content[0]?.status, 'complete');
  } finally {
    held.resolve();
  }
});

test('stale/replaced/recovered/finalized live sources cannot authorize hydration', async (t) => {
  const f = await transcriptHarness(t, 1);
  let value = live(f.snapshot, 'prefix');
  const source = value.run!.transcript!.source,
    chosen = selection(value.run!.transcript!.parts[0]);
  f.sources.set(JSON.stringify(source), { source, data: ['prefix'] });
  await f.publish(value);
  await f.transcript.loadPart(source, chosen);
  assert.equal(f.state.content[0].status, 'complete');
  await f.publish({ ...value, observationStatus: 'reconnecting' });
  assert.equal(f.state.content[0].status, 'source-changed');
  const calls = f.calls.length;
  await f.transcript.loadPart(source, chosen, true);
  value = live(value, 'recovery', digest('replacement incarnation'));
  await f.publish(value);
  await f.transcript.loadPart(source, chosen, true);
  await f.publish({ ...value, state: 'idle', run: null });
  await f.transcript.loadPart(source, chosen, true);
  assert.equal(f.calls.length, calls);
});

test('complete-source iterator works with injected reads, reports progress, validates cycles, and rejects cancellation/missing chunks', async () => {
  const f = transcriptFixture(1),
    source = f.entries[0].transcript!.source;
  const data = 'z'.repeat(100000),
    chosen = selection(part('m0.b0', data));
  f.sources.set(JSON.stringify(source), { source, data: [data, 'second'] });
  const progress: number[] = [];
  assert.equal(
    await collect(
      iterateTranscriptSource({
        read: makeTranscriptReader(f.chat),
        source,
        onProgress: (value) => progress.push(value.bytes),
      }),
    ),
    data + 'second',
  );
  assert(progress.length > 3);
  const abort = new AbortController();
  await assert.rejects(
    collect(
      iterateTranscriptSource({
        read: makeTranscriptReader(f.chat),
        source,
        selection: chosen,
        signal: abort.signal,
        onProgress: () => abort.abort(),
      }),
    ),
    // Electron main, its one consumer, reads the legacy code (until CL-24).
    { code: 'Cancelled' },
  );
  f.handlers.set('getChatTranscriptContent', async (_input, _signal, fallback) => ({
    ...(fallback() as object),
    offset: 5,
  }));
  await assert.rejects(
    collect(
      iterateTranscriptSource({
        read: makeTranscriptReader(f.chat),
        source,
        selection: chosen,
      }),
    ),
  );
  const liveSource: ChatTranscriptSource = {
    kind: 'live',
    target: f.target,
    submissionId: 's',
    taskId: 't',
    attempt: 0,
    incarnation: digest('live'),
  };
  await assert.rejects(
    collect(
      iterateTranscriptSource({
        read: makeTranscriptReader(f.chat),
        source: liveSource,
        selection: chosen,
      }),
    ),
    /authority/,
  );
});

// The fixture client is trusted: the chat runtime's ChatClient services own decoding and size bounds
// and test them. Shared code checks only meaning.
test('trusted ChatClient replies and snapshots are not decoded or size-bounded again', async (t) => {
  const f = await transcriptHarness(t, 1);
  const source = f.entries[0].transcript!.source,
    chosen = selection(f.entries[0].transcript!.parts[0]),
    padding = 'x'.repeat(maximumChatReplyBytes);
  f.handlers.set('getChatTranscriptContent', async (_input, _signal, fallback) => ({
    ...(fallback() as object),
    padding,
  }));
  assert.equal(
    await collect(iterateTranscriptSource({ read: makeTranscriptReader(f.chat), source })),
    'same text',
  );
  await f.transcript.loadManifest(source, true);
  assert.equal(f.state.manifest!.status, 'complete');
  await f.transcript.loadPart(source, chosen, true);
  assert.equal(f.state.content[0].status, 'complete');
  await f.publish({ ...f.snapshot, padding } as ChatSnapshot);
  assert.equal(f.state.observation, 'local');
  f.handlers.set('getChatTranscriptContent', async (_input, _signal, fallback) => ({
    ...(fallback() as object),
    kind: 'manifest',
  }));
  await assert.rejects(
    collect(
      iterateTranscriptSource({
        read: makeTranscriptReader(f.chat),
        source,
        selection: chosen,
      }),
    ),
    {
      code: 'Incompatible',
      message: 'Transcript reply does not match the captured selection.',
    },
  );
});

test('escaped summary data evicts at the byte budget before the row limit without losing earlier/later navigation', async (t) => {
  const f = await transcriptHarness(t, 50, { limits: scaledTranscriptLimits });
  for (const entry of f.entries) entry.text = '\u0001'.repeat(4096);
  await f.publish({ ...f.snapshot, entries: f.entries.slice(-8).reverse() });
  f.handlers.set('getChatHistoryAround', async (raw) => {
    const input = raw as { entryId: string; cursor?: string };
    const index = f.entries.findIndex((entry) => entry.id === input.entryId);
    const range = input.cursor
      ? (JSON.parse(input.cursor) as { lo: number; hi: number })
      : {
          lo: Math.max(0, index - 3),
          hi: Math.min(f.entries.length, index + 5),
        };
    const { lo, hi } = range;
    return {
      target: f.target,
      entryId: input.entryId,
      cursor: input.cursor ?? null,
      upperEntryId: 'e49',
      entries: f.entries.slice(lo, hi).reverse(),
      olderCursor: lo ? JSON.stringify({ lo: Math.max(0, lo - 8), hi: lo }) : null,
      newerCursor: hi < 50 ? JSON.stringify({ lo: hi, hi: Math.min(50, hi + 8) }) : null,
    };
  });
  for (let i = 0; i < 20 && f.state.earlier; i++) {
    await f.transcript.showEarlier();
    const state = f.state;
    assert.equal(state.error, null);
    assertBounds(state, f.limits);
  }
  const state = f.state;
  assert.equal(state.entries[0].id, 'e0');
  // Each entry serializes to about 24 KiB, so bytes, not the row count, bound retention.
  assert(
    state.entries.length < f.limits.summaryRecords / 5,
    'escaped bytes, not only row count, enforce retention',
  );
  assert(state.later);
  await f.transcript.jumpToEntry('e40');
  assert(f.state.entries.some((entry) => entry.id === 'e40'));
});

test('manifest and content LRU are bounded; view and expansion ID memory has finite retention', async (t) => {
  const f = await transcriptHarness(t, 2);
  for (let i = 0; i < 160; i++) {
    const source = f.entries[0].transcript!.source;
    const descriptor = part('m0.b0', 'version-' + i);
    f.sources.set(JSON.stringify(source), { source, data: ['version-' + i] });
    await f.transcript.loadPart(source, selection(descriptor));
  }
  assert(f.state.content.length <= 128);
  await f.transcript.setView({
    anchor: { key: 'entry:e0', offset: -2 },
    expanded: Array.from({ length: 400 }, (_, i) => 'expanded-' + i),
  });
  // The latest opened are kept.
  assert.deepEqual(
    f.state.view.expanded,
    Array.from({ length: 128 }, (_, i) => 'expanded-' + (272 + i)),
  );
  const { TranscriptViewMemory } = await import('@moonbase/application/chat');
  const memory = new TranscriptViewMemory();
  for (let i = 0; i < 70; i++)
    memory.set(
      'backend',
      { ...f.target, conversationId: 'conversation-' + i },
      { anchor: { key: 'entry:e0', offset: 0 }, expanded: [] },
    );
  assert.equal(
    memory.get('backend', { ...f.target, conversationId: 'conversation-0' }).anchor,
    null,
  );
  assert.equal(
    memory.get('backend', { ...f.target, conversationId: 'conversation-69' }).anchor!.key,
    'entry:e0',
  );
});

test('complete iteration rejects a manifest continuation cycle', async (t) => {
  const f = await transcriptHarness(t, 1);
  const source = f.entries[0].transcript!.source;
  f.handlers.set('getChatTranscriptContent', async (raw, _signal, fallback) => {
    const request = raw as { selection?: unknown; cursor?: string };
    if (request.selection) return fallback();
    const next = request.cursor === 'A' ? 'B' : 'A';
    return {
      kind: 'manifest',
      source,
      cursor: request.cursor ?? null,
      nextCursor: next,
      parts: [],
      thinking: 'none',
    };
  });
  await assert.rejects(
    collect(iterateTranscriptSource({ read: makeTranscriptReader(f.chat), source })),
    /advance/,
  );
});

test('changed entry descriptors invalidate relevant hydration', async (t) => {
  const f = await transcriptHarness(t, 1);
  const entry = f.entries[0],
    source = entry.transcript!.source;
  await f.transcript.loadPart(source, selection(entry.transcript!.parts[0]));
  await f.transcript.loadManifest(source);
  const replacement = {
    ...entry,
    text: 'replacement',
    transcript: { ...entry.transcript!, parts: [part('m0.b0', 'replacement')] },
  };
  await f.publish({ ...f.snapshot, entries: [replacement] });
  assert.equal(f.state.content[0].status, 'source-changed');
  assert.equal(f.state.manifest!.status, 'source-changed');
  f.sources.set(JSON.stringify(source), { source, data: ['replacement'] });
  await f.transcript.loadPart(source, selection(replacement.transcript.parts[0]));
  assert.equal(f.state.content.at(-1)!.chunks[0].data, 'replacement');
});

test('injected iteration captures its source before the first pull', async (t) => {
  const f = await transcriptHarness(t, 1);
  const injectedSource = structuredClone(f.entries[0].transcript!.source);
  const injected = iterateTranscriptSource({
    source: injectedSource,
    read: makeTranscriptReader(f.chat),
  });
  if (injectedSource.kind === 'entry') injectedSource.entryId = 'mutated';
  assert.equal(await collect(injected), 'same text');
});

test('an explicit around jump supersedes held navigation without late errors or finally replacing the chosen anchor', async (t) => {
  const f = await transcriptHarness(t);
  const entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<void>();
  f.handlers.set('getChatHistoryAround', async (input, _signal, fallback) => {
    if ((input as { entryId: string }).entryId === 'e320') {
      entered.resolve();
      const reply = fallback();
      await held.promise;
      return reply;
    }
    return fallback();
  });
  try {
    const old = f.transcript.jumpToEntry('e320');
    await entered.promise;
    await f.transcript.jumpToEntry('e100');
    await old;
    const current = f.state;
    assert.equal(current.view.anchor!.key, 'entry:e100');
    assert.equal(current.loading, false);
    held.resolve();
    await tick();
    assert.equal(f.state, current);
  } finally {
    held.resolve();
  }
});

test('a held continuation reports its actual retained offset after another selection evicts its cached prefix', async (t) => {
  const f = await transcriptHarness(t, 1),
    source = f.entries[0].transcript!.source;
  const data = ['x'.repeat(70000), ...Array.from({ length: 128 }, () => 'small')];
  f.sources.set(JSON.stringify(source), { source, data });
  const chosen = selection(part('m0.b0', data[0]));
  await f.transcript.loadPart(source, chosen);
  const entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<void>();
  f.handlers.set('getChatTranscriptContent', async (raw, _signal, fallback) => {
    const input = raw as { selection?: { partId: string }; cursor?: string };
    const result = fallback();
    if (input.selection?.partId === 'm0.b0' && input.cursor) {
      entered.resolve();
      await held.promise;
    }
    return result;
  });
  try {
    const reading = f.transcript.loadPart(source, chosen);
    await entered.promise;
    for (let index = 1; index < data.length; index++)
      await f.transcript.loadPart(source, selection(part('m0.b' + index, data[index])));
    held.resolve();
    await reading;
    const content = f.state.content.find((value) => value.selection.partId === 'm0.b0')!;
    assert.equal(content.chunks[0].offset, 32768);
    assert.equal(content.retainedFrom, 32768);
    assert.equal(content.loadedBytes, 65536);
  } finally {
    held.resolve();
  }
});

test('terminal onError invalidates completed live hydration even when a local watch omits reconnect status', async (t) => {
  const f = await transcriptHarness(t, 1);
  const value = live(f.snapshot, 'retained live');
  await f.publish(value);
  const source = value.run!.transcript!.source,
    chosen = selection(value.run!.transcript!.parts[0]);
  f.sources.set(JSON.stringify(source), { source, data: ['retained live'] });
  await f.transcript.loadManifest(source);
  await f.transcript.loadPart(source, chosen);
  assert.equal(f.state.content[0].status, 'complete');
  await f.transcript.fail(
    new ApplicationError({
      code: 'Unauthorized',
      message: 'authority revoked',
    }),
  );
  assert.equal(f.state.content[0].status, 'source-changed');
  assert.equal(f.state.manifest!.status, 'source-changed');
  const calls = f.calls.length;
  await f.transcript.loadPart(source, chosen);
  assert.equal(f.calls.length, calls);
  assert.equal(f.state.error, 'authority revoked');
});

test('history traverses every entry backward and forward across summary eviction', async (t) => {
  const f = await transcriptHarness(t, 300, { limits: scaledTranscriptLimits });
  for (const direction of ['earlier', 'later'] as const) {
    const seen = new Set<string>();
    for (let step = 0; step < 100; step++) {
      const state = f.state;
      for (const entry of state.entries) seen.add(entry.id);
      assert.equal(state.error, null);
      assertBounds(state, f.limits);
      assert.deepEqual(
        state.entries.map((entry) => entry.id),
        f.entries
          .filter((entry) => state.entries.some((value) => value.id === entry.id))
          .map((entry) => entry.id),
      );
      if (!state[direction]) break;
      await (direction === 'earlier' ? f.transcript.showEarlier() : f.transcript.showLater());
    }
    assert.equal(seen.size, 300, direction);
    const state = f.state;
    assert.equal(state[direction], false);
    assert.equal(state[direction === 'earlier' ? 'later' : 'earlier'], true);
  }
  assert.equal(f.state.entries.at(-1)!.id, 'e299');
});

function appendTranscriptEntries(f: TranscriptHarness, count: number) {
  for (let index = f.entries.length; index < count; index++) {
    const id = digest('durable-entry-' + index).slice(0, 24);
    f.entries.push({
      ...f.entries[0],
      id,
      transcript: {
        ...f.entries[0].transcript!,
        source: { kind: 'entry', target: f.target, entryId: id },
      },
    });
  }
}

test('disjoint coalesced latest snapshots leave all retained history reachable in both directions', async (t) => {
  const f = await transcriptHarness(t, 64);
  appendTranscriptEntries(f, 128);
  await f.publish({
    ...f.snapshot,
    entries: f.entries.slice(-32).reverse(),
    transcriptBoundary: f.entries.at(-1)!.id,
    olderCursor: '96',
  });
  for (const direction of ['earlier', 'later'] as const) {
    const seen = new Set<string>();
    for (let step = 0; step < 40; step++) {
      const state = f.state;
      state.entries.forEach((entry) => seen.add(entry.id));
      assert.equal(state.error, null);
      assert.deepEqual(
        state.entries.map((entry) => entry.id),
        f.entries
          .filter((entry) => state.entries.some((value) => value.id === entry.id))
          .map((entry) => entry.id),
      );
      if (!state[direction]) break;
      await (direction === 'earlier' ? f.transcript.showEarlier() : f.transcript.showLater());
    }
    assert.equal(seen.size, 128, direction);
    assert.equal(f.state[direction], false);
  }
  assert.equal(f.state.atLatest, true);
});

test('disjoint latest updates preserve an around-entry anchor and bridge to later history', async (t) => {
  const f = await transcriptHarness(t, 64);
  await f.transcript.jumpToEntry('e16');
  await f.transcript.setView({
    anchor: { key: 'entry:e16', offset: -13 },
    expanded: ['thought'],
  });
  const before = f.state,
    reads = f.calls.length;
  appendTranscriptEntries(f, 640);
  await f.publish({
    ...f.snapshot,
    entries: f.entries.slice(-32).reverse(),
    transcriptBoundary: f.entries.at(-1)!.id,
    olderCursor: '608',
  });
  assert.equal(f.state.entries, before.entries);
  assert.deepEqual(f.state.view, before.view);
  assert.equal(f.calls.length, reads);
  await f.transcript.showEarlier();
  const seen = new Set<string>();
  for (let step = 0; step < 100; step++) {
    const state = f.state;
    state.entries.forEach((entry) => seen.add(entry.id));
    assert.equal(state.error, null);
    assertBounds(state);
    if (!state.later) break;
    await f.transcript.showLater();
  }
  assert.equal(seen.size, 640);
  // Back at the newest entry, the reader following the end follows the live edge again.
  await f.transcript.setView({ anchor: null, expanded: ['thought'] });
  assert.equal(f.state.atLatest, true);
});

test('a page read whose records a following snapshot replaced is dropped', async (t) => {
  const f = await transcriptHarness(t, 64);
  const entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<void>();
  let holding = true;
  f.handlers.set('getChatHistoryAround', async (_input, _signal, fallback) => {
    const page = fallback();
    if (holding) {
      holding = false;
      entered.resolve();
      await held.promise;
    }
    return page;
  });
  try {
    // A short conversation pages earlier while its reader still follows the live edge.
    const reading = f.transcript.showEarlier();
    await entered.promise;
    const { dataset } = f.state;
    appendTranscriptEntries(f, 128);
    await f.publish({
      ...f.snapshot,
      entries: f.entries.slice(-32).reverse(),
      transcriptBoundary: f.entries.at(-1)!.id,
      olderCursor: '96',
    });
    held.resolve();
    await reading;
    let state = f.state;
    assert.equal(state.dataset, dataset + 1);
    assert.equal(state.error, null);
    assert.equal(state.atLatest, true);
    assert.deepEqual(
      state.entries.map((entry) => entry.id),
      f.entries.slice(-32).map((entry) => entry.id),
      'the old page does not extend the new records',
    );
    const seen = new Set<string>();
    for (let step = 0; step < 80 && state.earlier; step++) {
      await f.transcript.showEarlier();
      state = f.state;
      state.entries.forEach((entry) => seen.add(entry.id));
      assert.equal(state.error, null);
      assertBounds(state);
    }
    assert.equal(seen.size, 128);
  } finally {
    held.resolve();
  }
});

for (const replacement of ['around', 'latest'] as const)
  for (const oldOutcome of ['success', 'error'] as const)
    test(`${replacement} supersedes held older navigation without late ${oldOutcome} changing its loading or failure`, async (t) => {
      const f = await transcriptHarness(t, 64);
      const oldEntered = Promise.withResolvers<void>(),
        oldHeld = Promise.withResolvers<void>();
      const newEntered = Promise.withResolvers<void>(),
        newHeld = Promise.withResolvers<void>();
      f.handlers.set('getChatHistoryAround', async (raw, _signal, fallback) => {
        const page = fallback();
        if ((raw as { entryId: string }).entryId === 'e32') {
          oldEntered.resolve();
          await oldHeld.promise;
          if (oldOutcome === 'error')
            throw new ApplicationError({
              code: 'Unavailable',
              message: 'obsolete history failed',
            });
        } else {
          newEntered.resolve();
          await newHeld.promise;
        }
        return page;
      });
      f.handlers.set('getChat', async (_raw, _signal, fallback) => {
        const snapshot = fallback();
        newEntered.resolve();
        await newHeld.promise;
        return snapshot;
      });
      try {
        const old = f.transcript.showEarlier();
        await oldEntered.promise;
        // The reader leaves the live edge, so the new snapshot leaves a gap to read.
        await f.transcript.setView({
          anchor: { key: 'entry:e40', offset: 0 },
          expanded: [],
        });
        appendTranscriptEntries(f, 128);
        await f.publish({
          ...f.snapshot,
          entries: f.entries.slice(-32).reverse(),
          transcriptBoundary: f.entries.at(-1)!.id,
          olderCursor: '96',
        });
        const current =
          replacement === 'around' ? f.transcript.jumpToEntry('e10') : f.transcript.jumpToLatest();
        await newEntered.promise;
        const loading = f.state;
        await old;
        assert.equal(f.state, loading, 'old cancellation/finally cannot clear newer loading');
        assert.equal(loading.loading, true);
        newHeld.reject(
          new ApplicationError({
            code: 'Unavailable',
            message: 'newer navigation failed',
          }),
        );
        await current;
        const failed = f.state;
        assert.equal(failed.loading, false);
        assert.match(failed.error!, /newer navigation failed/);
        oldHeld.resolve();
        await tick();
        assert.equal(f.state, failed, 'old settlement cannot clear newer error or merge its page');
      } finally {
        oldHeld.resolve();
        newHeld.resolve();
      }
    });

test('held anchor restoration preserves its upper bound and relative offset through a disjoint snapshot', async (t) => {
  const f = await transcriptHarness(t, 64);
  await f.transcript.setView({
    anchor: { key: 'entry:e16', offset: -9 },
    expanded: ['thought'],
  });
  await f.reopen();
  const entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<void>();
  let upper: string | undefined;
  f.handlers.set('getChatHistoryAround', async (_raw, _signal, fallback) => {
    const page = fallback() as { upperEntryId: string };
    if (!upper) {
      upper = page.upperEntryId;
      entered.resolve();
      await held.promise;
    }
    return page;
  });
  try {
    const restoring = f.transcript.restoreView();
    await entered.promise;
    appendTranscriptEntries(f, 128);
    await f.publish({
      ...f.snapshot,
      entries: f.entries.slice(-32).reverse(),
      transcriptBoundary: f.entries.at(-1)!.id,
      olderCursor: '96',
    });
    held.resolve();
    await restoring;
    const state = f.state;
    assert.equal(upper, 'e63');
    assert.deepEqual(state.view, {
      anchor: { key: 'entry:e16', offset: -9 },
      expanded: ['thought'],
    });
    assert(
      state.entries.every((entry) => f.entries.findIndex((value) => value.id === entry.id) < 64),
    );
    assert.equal(state.atLatest, false);
    assert.equal(state.error, null);
    assert(state.later);
    for (let step = 0; step < 30 && f.state.later; step++) await f.transcript.showLater();
    assert.equal(f.state.later, false);
    assert.equal(f.state.entries.at(-1)!.id, f.entries.at(-1)!.id);
    assert.equal(f.state.error, null);
  } finally {
    held.resolve();
  }
});

test('navigation at an unavailable boundary or failed observation does not move the window or clear errors', async (t) => {
  const f = await transcriptHarness(t, 64);
  const latest = f.state,
    calls = f.calls.length;
  await f.transcript.showLater();
  assert.equal(f.state, latest);
  assert.equal(f.calls.length, calls);
  await f.transcript.jumpToEntry('e0');
  const beginning = f.state,
    reads = f.calls.length;
  await f.transcript.showEarlier();
  assert.equal(f.state, beginning);
  assert.equal(f.calls.length, reads);
  await f.transcript.fail(
    new ApplicationError({
      code: 'Unauthorized',
      message: 'observation authority revoked',
    }),
  );
  const failed = f.state;
  await f.transcript.showEarlier();
  await f.transcript.showLater();
  await f.transcript.jumpToEntry('e10');
  await f.transcript.jumpToLatest();
  assert.equal(f.state, failed);
  assert.equal(f.calls.length, reads);
  assert.match(failed.error!, /observation authority revoked/);
});

test('large part manifests release descriptors before evicting navigable history', async (t) => {
  const f = await transcriptHarness(t, 640);
  const source = f.entries[320].transcript!.source;
  f.sources.set(JSON.stringify(source), {
    source,
    data: Array.from({ length: 300 }, () => 'part'),
  });
  f.entries[320].transcript = {
    source,
    parts: Array.from({ length: 4 }, (_, index) => part(`m0.b${index}`, 'part')),
    nextCursor: '4',
    thinking: 'none',
  };
  await f.transcript.jumpToEntry('e320');
  for (let index = 0; index < 10; index++) await f.transcript.loadManifest(source);
  const seen = new Set<string>();
  for (let index = 0; index < 100; index++) {
    const state = f.state;
    for (const entry of state.entries) seen.add(entry.id);
    assert.equal(state.error, null);
    assertBounds(state);
    if (!state.earlier) break;
    await f.transcript.showEarlier();
  }
  assert.deepEqual(
    f.entries.slice(0, 321).filter((entry) => !seen.has(entry.id)),
    [],
  );
});

test('later navigation at the newer edge always advances the retained history', async (t) => {
  const f = await transcriptHarness(t, 300, { limits: scaledTranscriptLimits });
  for (let i = 0; i < 100 && f.state.earlier; i++) await f.transcript.showEarlier();
  for (let i = 0; i < 100 && f.state.later; i++) {
    const before = f.state.entries.map((e) => e.id);
    await f.transcript.showLater();
    const after = f.state;
    if (JSON.stringify(before) === JSON.stringify(after.entries.map((e) => e.id))) {
      assert.fail('Later returned the same history while later remained true');
    }
  }
});

for (const outcome of ['success', 'error'] as const)
  test(`new view capture fences held startup restoration ${outcome}`, async (t) => {
    const f = await transcriptHarness(t, 640);
    await f.transcript.setView({
      anchor: { key: 'entry:e100', offset: -4 },
      expanded: [],
    });
    await f.reopen();
    const entered = Promise.withResolvers<void>(),
      held = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    f.handlers.set('getChatHistoryAround', async (_input, abort, fallback) => {
      signal = abort;
      const reply = fallback();
      entered.resolve();
      await held.promise;
      if (outcome === 'error')
        throw new ApplicationError({
          code: 'Unavailable',
          message: 'obsolete restore failed',
        });
      return reply;
    });
    try {
      const restoring = f.transcript.restoreView();
      await entered.promise;
      const before = f.state.entries;
      assert(before.some((entry) => entry.id === 'e620'));
      const view = {
        anchor: { key: 'entry:e620', offset: -21 },
        expanded: ['new'],
      };
      await f.transcript.setView(view);
      assert.equal(signal?.aborted, true);
      held.resolve();
      await restoring;
      await tick();
      const after = f.state;
      assert.deepEqual(after.entries, before);
      assert.deepEqual(after.view, view);
      assert.equal(after.loading, false);
      assert.equal(after.error, null);
    } finally {
      held.resolve();
    }
  });

test('Retry after a failed view restore keeps the saved offset; other jumps place the entry at its top', async (t) => {
  const f = await transcriptHarness(t, 640);
  await f.transcript.setView({
    anchor: { key: 'entry:e100', offset: 37 },
    expanded: [],
  });
  await f.reopen();
  let failed = false;
  f.handlers.set('getChatHistoryAround', async (_raw, _signal, fallback) => {
    if (failed) return fallback();
    failed = true;
    throw new ApplicationError({
      code: 'Unavailable',
      message: 'Controlled restore failure',
    });
  });
  await f.transcript.restoreView();
  let state = f.state;
  assert.match(state.error ?? '', /Controlled restore failure/);
  assert(!state.entries.some((entry) => entry.id === 'e100'));
  assert.deepEqual(state.view.anchor, { key: 'entry:e100', offset: 37 });
  // Retry jumps to the saved anchor's entry, which isn't retained.
  await f.transcript.jumpToEntry('e100');
  state = f.state;
  assert(state.entries.some((entry) => entry.id === 'e100'));
  assert.equal(state.error, null);
  assert.equal(state.atLatest, false);
  assert.deepEqual(state.view.anchor, { key: 'entry:e100', offset: 37 });
  // Once retained, a jump to it places it at its top, as does a jump elsewhere.
  await f.transcript.jumpToEntry('e100');
  assert.deepEqual(f.state.view.anchor, {
    key: 'entry:e100',
    offset: 0,
  });
  await f.transcript.jumpToEntry('e400');
  assert.deepEqual(f.state.view.anchor, {
    key: 'entry:e400',
    offset: 0,
  });
});

test('a view saved before the restore runs cancels it without losing older history', async (t) => {
  const f = await transcriptHarness(t, 640);
  await f.transcript.setView({
    anchor: { key: 'entry:e100', offset: -4 },
    expanded: [],
  });
  await f.reopen();
  const reads = f.calls.length;
  await f.transcript.setView({
    anchor: { key: 'entry:e620', offset: -21 },
    expanded: [],
  });
  await f.transcript.restoreView();
  assert.equal(f.calls.length, reads);
  assert.equal(f.state.earlier, true);
  const seen = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const s = f.state;
    s.entries.forEach((e) => seen.add(e.id));
    if (!s.earlier) break;
    await f.transcript.showEarlier();
  }
  assert.equal(seen.size, 640);
});

test('a reconnecting snapshot cancels an evicted live part read without an error or re-adding it', async (t) => {
  const f = await transcriptHarness(t, 200);
  const running = live(f.snapshot, 'live text');
  await f.publish(running);
  const transcript = running.run!.transcript!;
  const held = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  f.handlers.set('getChatTranscriptContent', async (raw, abort, fallback) => {
    if ((raw as { source: ChatTranscriptSource }).source.kind !== 'live') return fallback();
    signal = abort;
    await held.promise;
    throw new ApplicationError({
      code: 'Unavailable',
      message: 'late live failure',
    });
  });
  const pending = f.transcript.loadPart(transcript.source, selection(transcript.parts[0]));
  await until(() => !!signal);
  // Filling the cache with other selections evicts the loading live part.
  for (const entry of f.entries.slice(0, 128))
    await f.transcript.loadPart(entry.transcript!.source, selection(entry.transcript!.parts[0]));
  const hasLive = (state: TranscriptState) =>
    state.content.some((content) => content.source.kind === 'live');
  assert.equal(hasLive(f.state), false);
  await f.publish({ ...running, observationStatus: 'reconnecting' });
  assert.equal(signal!.aborted, true);
  held.resolve();
  await pending;
  await tick();
  assert.equal(f.state.error, null);
  assert.equal(hasLive(f.state), false);
});
