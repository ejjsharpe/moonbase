import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApplicationError } from '@moonbase/contracts/errors';
import {
  iterateTranscriptSource,
  makeTranscriptReader,
  transcriptLimits,
} from '@moonbase/application/chat';
import { maximumChatReplyBytes } from '@moonbase/contracts/chat';
import type { ChatSnapshot, ChatTranscriptSource } from '@moonbase/contracts/chat';
import type { TranscriptState } from '@moonbase/application/chat';
import {
  digest,
  part,
  tick,
  transcriptController,
  transcriptFixture,
  type ContentReply,
} from './transcript-fixture.ts';

const selection = (value: ReturnType<typeof part>) => ({
  partId: value.partId,
  bytes: value.bytes,
  revision: value.revision,
});
async function collect(iterator: AsyncIterable<{ data: string }>) {
  let text = '';
  for await (const chunk of iterator) text += chunk.data;
  return text;
}
const serialized = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
/** Published summaries and content stay within their budgets. */
function assertBounds(state: TranscriptState) {
  assert(
    state.entries.length + (state.manifest?.parts.length ?? 0) <= transcriptLimits.summaryRecords,
  );
  assert(
    serialized({ entries: state.entries, manifest: state.manifest }) <=
      transcriptLimits.summaryBytes,
  );
  assert(
    state.content.reduce((total, content) => total + serialized(content), 0) <=
      transcriptLimits.contentBytes,
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
      tools: [],
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
        thinking: 'pending',
        nextCursor: null,
      },
    },
  };
}

test('canonical history traverses >2 overlapping pages, both continuations, eviction and around restoration without text deduplication', async (t) => {
  const f = await transcriptController(t, 2400);
  const seen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const state = f.controller.getSnapshot().transcript;
    state.entries.forEach((entry) => seen.add(entry.id));
    assertBounds(state);
    assert.deepEqual(
      state.entries.map((entry) => Number(entry.id.slice(1))),
      state.entries.map((entry) => Number(entry.id.slice(1))).sort((a, b) => a - b),
    );
    if (!state.earlier) break;
    await f.controller.showEarlier();
    assert.equal(f.controller.getSnapshot().transcript.error, null);
  }
  assert.equal(seen.size, 2400);
  assert.equal(f.controller.getSnapshot().transcript.entries[0].id, 'e0');
  // Retained history needs no read to show an entry; evicted history reads around it.
  const arounds = () => f.calls.filter((call) => call.operation === 'getChatHistoryAround').length;
  let reads = arounds();
  assert.equal(await f.controller.jumpToEntry('e320'), 'entry:e320');
  assert.equal(arounds(), reads);
  assert.equal(await f.controller.jumpToEntry('e1600'), 'entry:e1600');
  assert.equal(arounds(), reads + 1);
  let state = f.controller.getSnapshot().transcript;
  assert(state.entries.some((entry) => entry.id === 'e1600'));
  assert(state.earlier && state.later);
  await f.controller.showEarlier();
  await f.controller.showLater();
  state = f.controller.getSnapshot().transcript;
  assert(state.entries.some((entry) => entry.id === 'e1600'));
  f.publish({ ...f.snapshot, state: 'running', message: 'latest changed' });
  assert.equal(
    f.controller.getSnapshot().transcript.entries,
    state.entries,
    'live state does not replace historical window',
  );
  await f.controller.jumpToLatest();
  assert.equal(f.controller.getSnapshot().transcript.entries.at(-1)?.id, 'e2399');
  reads = arounds();
  assert(reads > 2);
});

test('cloned live-only DTOs preserve summary/part/cache identity and unrelated replacements publish nothing', async (t) => {
  const f = await transcriptController(t, 40);
  const entry = f.controller.getSnapshot().transcript.entries[0],
    source = entry.transcript!.source,
    chosen = selection(entry.transcript!.parts[0]);
  await f.controller.loadTranscriptPart(source, chosen);
  await f.controller.loadTranscriptManifest(source);
  const cache = f.controller.getSnapshot().transcript.content[0];
  let value = live(f.snapshot, 'one');
  f.fixture.sources.set(JSON.stringify(value.run!.transcript!.source), {
    source: value.run!.transcript!.source,
    data: ['one'],
  });
  f.publish(value);
  const stableEntry = f.controller.getSnapshot().transcript.entries[0];
  const stablePart = stableEntry.transcript!.parts[0];
  const calls = f.calls.length;
  for (let i = 0; i < 8; i++) {
    value = live(value, 'progress ' + i);
    f.publish(value);
  }
  assert.equal(f.controller.getSnapshot().transcript.entries[0], stableEntry);
  assert.equal(f.controller.getSnapshot().transcript.entries[0].transcript!.parts[0], stablePart);
  assert.equal(f.controller.getSnapshot().transcript.content[0], cache);
  assert.equal(f.calls.length, calls);
  const before = f.controller.getSnapshot();
  let notifications = 0;
  const off = f.controller.subscribe(() => notifications++);
  f.publish(structuredClone(value));
  assert.equal(f.controller.getSnapshot(), before);
  assert.equal(notifications, 0);
  f.fail(new ApplicationError({ code: 'Unauthorized', message: 'authority revoked' }));
  assert.match(f.controller.getSnapshot().error!, /^Unauthorized:/);
  assert.equal(f.controller.getSnapshot().transcript.observation, 'failed');
  assert(notifications > 0);
  off();
});

test('selected manifest hydration advances and retries errors; content validates exact echoes and offsets', async (t) => {
  const f = await transcriptController(t, 1);
  const source = f.entries[0].transcript!.source;
  f.fixture.sources.set(JSON.stringify(source), {
    source,
    data: Array.from({ length: 70 }, (_, i) => 'part-' + i),
  });
  await f.controller.loadTranscriptManifest(source);
  assert.equal(f.controller.getSnapshot().transcript.manifest!.parts.length, 32);
  f.handlers.set('getChatTranscriptContent', async () => {
    throw new ApplicationError({ code: 'Unavailable', message: 'held network failed' });
  });
  await f.controller.loadTranscriptManifest(source);
  assert.equal(f.controller.getSnapshot().transcript.manifest!.status, 'error');
  assert.equal(f.controller.getSnapshot().transcript.manifest!.nextCursor, '32');
  f.handlers.clear();
  await f.controller.loadTranscriptManifest(source);
  await f.controller.loadTranscriptManifest(source);
  assert.equal(f.controller.getSnapshot().transcript.manifest!.parts.length, 70);
  assert.equal(f.controller.getSnapshot().transcript.manifest!.status, 'complete');
  const data = 'x'.repeat(70000),
    chosen = selection(part('m0.b0', data));
  f.fixture.sources.set(JSON.stringify(source), { source, data: [data] });
  await f.controller.loadTranscriptPart(source, chosen);
  assert.equal(f.controller.getSnapshot().transcript.content[0].loadedBytes, 32768);
  // A short terminal chunk is rejected by the ChatClient boundary's reply schema.
  for (const corrupt of ['offset', 'target', 'revision'] as const) {
    f.handlers.set('getChatTranscriptContent', async (_input, _signal, fallback) => {
      const reply = structuredClone(fallback()) as ContentReply;
      if (corrupt === 'offset') reply.offset--;
      if (corrupt === 'target') reply.source.target.actorId = 'foreign';
      if (corrupt === 'revision') reply.selection.revision = digest('foreign');
      return reply;
    });
    await f.controller.loadTranscriptPart(source, chosen);
    assert.equal(f.controller.getSnapshot().transcript.content[0].status, 'error', corrupt);
    assert.equal(f.controller.getSnapshot().transcript.content[0].loadedBytes, 32768, corrupt);
  }
  f.handlers.clear();
  await f.controller.loadTranscriptPart(source, chosen);
  await f.controller.loadTranscriptPart(source, chosen);
  assert.equal(f.controller.getSnapshot().transcript.content[0].status, 'complete');
  assert.equal(
    f.controller
      .getSnapshot()
      .transcript.content[0].chunks.map((chunk) => chunk.data)
      .join(''),
    data,
  );
});

test('one oversized part stays incrementally readable within the LRU; complete-source iteration is independent of cache', async (t) => {
  const f = await transcriptController(t, 1);
  const source = f.entries[0].transcript!.source,
    data = 'a'.repeat(9 * 1024 * 1024),
    chosen = selection(part('m0.b0', data));
  f.fixture.sources.set(JSON.stringify(source), { source, data: [data] });
  for (let i = 0; i < Math.ceil(data.length / 32768); i++)
    await f.controller.loadTranscriptPart(source, chosen);
  const view = f.controller.getSnapshot().transcript;
  assertBounds(view);
  assert(view.content[0].retainedFrom > 0, 'oversized active selection is not exempt from budget');
  assert.equal(view.content[0].loadedBytes, data.length);
  assert.equal(
    await collect(
      iterateTranscriptSource({ read: makeTranscriptReader(f.chat), source, selection: chosen }),
    ),
    data,
  );
});

test('summary byte and record budgets include hydrated descriptors and envelopes; complete iteration passes descriptor eviction', async (t) => {
  const f = await transcriptController(t, 1);
  const source = f.entries[0].transcript!.source,
    data = Array.from({ length: transcriptLimits.summaryRecords + 64 }, () => 'b'.repeat(256));
  f.fixture.sources.set(JSON.stringify(source), { source, data });
  for (let i = 0; i < data.length / 32 + 1; i++) await f.controller.loadTranscriptManifest(source);
  const state = f.controller.getSnapshot().transcript;
  assertBounds(state);
  assert(state.manifest!.omittedParts > 0);
  assert.equal(
    await collect(iterateTranscriptSource({ read: makeTranscriptReader(f.chat), source })),
    data.join(''),
  );
});

for (const lifecycle of ['selection', 'hide', 'close', 'dispose', 'reconnect'] as const)
  test(`held read cancels/fences late success, progress and finally across ${lifecycle}; cleanup retains actual settlement`, async (t) => {
    const f = await transcriptController(t, 40);
    const source = f.entries[0].transcript!.source,
      chosen = selection(f.entries[0].transcript!.parts[0]);
    const entered = Promise.withResolvers<void>(),
      held = Promise.withResolvers<unknown>();
    f.handlers.set('getChatTranscriptContent', async (_input, _signal, fallback) => {
      entered.resolve();
      await held.promise;
      return fallback();
    });
    const read = f.controller.loadTranscriptPart(source, chosen);
    await entered.promise;
    try {
      let cleanup: Promise<unknown> | undefined;
      if (lifecycle === 'selection')
        await f.controller.select({ ...f.target, conversationId: 'B' });
      if (lifecycle === 'hide') cleanup = f.controller.detach();
      if (lifecycle === 'close') cleanup = f.controller.closeView();
      if (lifecycle === 'dispose') cleanup = f.controller.dispose();
      if (lifecycle === 'reconnect') {
        cleanup = f.controller.detach();
        await f.controller.start();
        await f.controller.select(f.target);
      }
      let settled = false;
      void cleanup?.then(() => {
        settled = true;
      });
      await tick();
      if (cleanup) assert.equal(settled, false);
      assert(
        f.calls.find((call) => call.operation === 'getChatTranscriptContent')!.signal!.aborted,
      );
      f.controller.setDraft('draft remains independent');
      held.resolve(undefined);
      await read;
      await cleanup;
      assert.equal(f.controller.getSnapshot().transcript.content.length, 0);
    } finally {
      held.resolve(undefined);
    }
  });

test('stale/replaced/recovered/finalized live sources cannot authorize hydration', async (t) => {
  const f = await transcriptController(t, 1);
  let value = live(f.snapshot, 'prefix');
  const source = value.run!.transcript!.source,
    chosen = selection(value.run!.transcript!.parts[0]);
  f.fixture.sources.set(JSON.stringify(source), { source, data: ['prefix'] });
  f.publish(value);
  await f.controller.loadTranscriptPart(source, chosen);
  assert.equal(f.controller.getSnapshot().transcript.content[0].status, 'complete');
  f.publish({ ...value, observationStatus: 'reconnecting' });
  assert.equal(f.controller.getSnapshot().transcript.content[0].status, 'source-changed');
  const calls = f.calls.length;
  await f.controller.loadTranscriptPart(source, chosen, true);
  value = live(value, 'recovery', digest('replacement incarnation'));
  f.publish(value);
  await f.controller.loadTranscriptPart(source, chosen, true);
  f.publish({ ...value, state: 'idle', run: null });
  await f.controller.loadTranscriptPart(source, chosen, true);
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
    (error) => ApplicationError.is(error) && error.code === 'Cancelled',
  );
  f.handlers.set('getChatTranscriptContent', async (_input, _signal, fallback) => ({
    ...(fallback() as object),
    offset: 5,
  }));
  await assert.rejects(
    collect(
      iterateTranscriptSource({ read: makeTranscriptReader(f.chat), source, selection: chosen }),
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

// The fixture client is trusted: the Pi runtime's ChatClient services own decoding and size bounds
// and test them. Shared code checks only meaning.
test('trusted ChatClient replies and snapshots are not decoded or size-bounded again', async (t) => {
  const f = await transcriptController(t, 1);
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
  await f.controller.loadTranscriptManifest(source, true);
  assert.equal(f.controller.getSnapshot().transcript.manifest!.status, 'complete');
  await f.controller.loadTranscriptPart(source, chosen, true);
  assert.equal(f.controller.getSnapshot().transcript.content[0].status, 'complete');
  f.publish({ ...f.snapshot, padding } as ChatSnapshot);
  await tick();
  assert.equal(f.controller.getSnapshot().transcript.observation, 'local');
  assert.equal(f.controller.getSnapshot().error, null);
  f.handlers.set('getChatTranscriptContent', async (_input, _signal, fallback) => ({
    ...(fallback() as object),
    kind: 'manifest',
  }));
  await assert.rejects(
    collect(
      iterateTranscriptSource({ read: makeTranscriptReader(f.chat), source, selection: chosen }),
    ),
    {
      code: 'Incompatible',
      message: 'Transcript reply does not match the captured selection.',
    },
  );
});

test('escaped summary data evicts at four MiB before the row limit without losing earlier/later navigation', async (t) => {
  const f = await transcriptController(t, 400);
  for (const entry of f.entries) entry.text = '\u0001'.repeat(4096);
  f.publish({ ...f.snapshot, entries: f.entries.slice(-8).reverse() });
  f.handlers.set('getChatHistoryAround', async (raw) => {
    const input = raw as { entryId: string; cursor?: string };
    const index = f.entries.findIndex((entry) => entry.id === input.entryId);
    const range = input.cursor
      ? (JSON.parse(input.cursor) as { lo: number; hi: number })
      : { lo: Math.max(0, index - 3), hi: Math.min(f.entries.length, index + 5) };
    const { lo, hi } = range;
    return {
      target: f.target,
      entryId: input.entryId,
      cursor: input.cursor ?? null,
      upperEntryId: 'e399',
      entries: f.entries.slice(lo, hi).reverse(),
      olderCursor: lo ? JSON.stringify({ lo: Math.max(0, lo - 8), hi: lo }) : null,
      newerCursor: hi < 400 ? JSON.stringify({ lo: hi, hi: Math.min(400, hi + 8) }) : null,
    };
  });
  for (let i = 0; i < 60 && f.controller.getSnapshot().transcript.earlier; i++) {
    await f.controller.showEarlier();
    const state = f.controller.getSnapshot().transcript;
    assert.equal(state.error, null);
    assertBounds(state);
  }
  const state = f.controller.getSnapshot().transcript;
  assert.equal(state.entries[0].id, 'e0');
  // Each entry serializes to about 24 KiB, so bytes, not the row count, bound retention.
  assert(state.entries.length < 200, 'escaped bytes, not only row count, enforce retention');
  assert(state.later);
  await f.controller.jumpToEntry('e320');
  assert(f.controller.getSnapshot().transcript.entries.some((entry) => entry.id === 'e320'));
});

test('manifest and content LRU are bounded; view and expansion ID memory has finite retention', async (t) => {
  const f = await transcriptController(t, 2);
  for (let i = 0; i < 160; i++) {
    const source = f.entries[0].transcript!.source;
    const descriptor = part('m0.b0', 'version-' + i);
    f.fixture.sources.set(JSON.stringify(source), { source, data: ['version-' + i] });
    await f.controller.loadTranscriptPart(source, selection(descriptor));
  }
  assert(f.controller.getSnapshot().transcript.content.length <= 128);
  f.controller.setTranscriptView({
    anchor: { key: 'entry:e0', offset: -2 },
    expanded: Array.from({ length: 400 }, (_, i) => 'expanded-' + i),
  });
  assert.equal(f.controller.getSnapshot().transcript.view.expanded.length, 128);
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
  const f = await transcriptController(t, 1);
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

test('changed entry descriptors invalidate relevant hydration; explicit refresh reattaches a failed observation', async (t) => {
  const f = await transcriptController(t, 1, true, { transcriptWatchRetryMs: [] });
  const entry = f.entries[0],
    source = entry.transcript!.source;
  await f.controller.loadTranscriptPart(source, selection(entry.transcript!.parts[0]));
  await f.controller.loadTranscriptManifest(source);
  const replacement = {
    ...entry,
    text: 'replacement',
    transcript: { ...entry.transcript!, parts: [part('m0.b0', 'replacement')] },
  };
  f.publish({ ...f.snapshot, entries: [replacement] });
  assert.equal(f.controller.getSnapshot().transcript.content[0].status, 'source-changed');
  assert.equal(f.controller.getSnapshot().transcript.manifest!.status, 'source-changed');
  f.fixture.sources.set(JSON.stringify(source), { source, data: ['replacement'] });
  await f.controller.loadTranscriptPart(source, selection(replacement.transcript.parts[0]));
  assert.equal(f.controller.getSnapshot().transcript.content.at(-1)!.chunks[0].data, 'replacement');
  f.fail(new ApplicationError({ code: 'Unavailable', message: 'watch failed' }));
  assert.equal(f.controller.getSnapshot().transcript.observation, 'failed');
  const terminal = f.controller.getSnapshot();
  f.publish(f.fixture.snapshot);
  assert.equal(f.controller.getSnapshot(), terminal, 'terminal onError fences late watch values');
  await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().transcript.observation, 'local');
  assert.equal(f.fixture.watchCloses, 1);
});

test('injected iteration captures its source before the first pull', async (t) => {
  const f = await transcriptController(t, 1);
  const injectedSource = structuredClone(f.entries[0].transcript!.source);
  const injected = iterateTranscriptSource({
    source: injectedSource,
    read: makeTranscriptReader(f.chat),
  });
  if (injectedSource.kind === 'entry') injectedSource.entryId = 'mutated';
  assert.equal(await collect(injected), 'same text');
});

test('remote connection generation replacement cancels held reads and fences their late failure', async (t) => {
  const f = await transcriptController(t, 1, false);
  await f.controller.refresh();
  await f.controller.select(f.target);
  const entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<void>();
  f.handlers.set('getChatTranscriptContent', async () => {
    entered.resolve();
    await held.promise;
    throw new ApplicationError({ code: 'Unavailable', message: 'old generation failed' });
  });
  try {
    const read = f.controller.loadTranscriptManifest(f.entries[0].transcript!.source);
    await entered.promise;
    const previous = f.controller.getSnapshot().connection!.connectionId;
    await f.controller.disconnect();
    await read;
    assert(f.calls.find((call) => call.operation === 'getChatTranscriptContent')!.signal!.aborted);
    await f.controller.connect();
    await f.controller.refresh();
    assert.notEqual(f.controller.getSnapshot().connection!.connectionId, previous);
    const current = f.controller.getSnapshot();
    held.resolve();
    await tick();
    assert.equal(f.controller.getSnapshot(), current);
    assert.equal(current.transcript.content.length, 0);
    assert.equal(current.transcript.error, null);
  } finally {
    held.resolve();
  }
});

for (const failure of [false, true])
  test(`Disconnect closes observation without joining raw content ${failure ? 'failure' : 'success'}; root disposal still drains it`, async (t) => {
    const f = await transcriptController(t, 1, false);
    await f.controller.refresh();
    await f.controller.select(f.target);
    const entered = Promise.withResolvers<void>(),
      held = Promise.withResolvers<void>();
    f.handlers.set('getChatTranscriptContent', async (_input, _signal, fallback) => {
      entered.resolve();
      await held.promise;
      if (failure)
        throw new ApplicationError({ code: 'Unavailable', message: 'obsolete raw read failed' });
      return fallback();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const read = f.controller.loadTranscriptManifest(f.entries[0].transcript!.source);
      await entered.promise;
      const closes = f.fixture.watchCloses;
      await Promise.race([
        f.controller.disconnect(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(Error('Disconnect joined held raw content')), 5000);
        }),
      ]);
      clearTimeout(timer);
      await read;
      assert(f.fixture.watchCloses > closes);
      assert(
        f.calls.find((call) => call.operation === 'getChatTranscriptContent')!.signal!.aborted,
      );
      let disposed = false;
      const disposal = f.controller.dispose().then(() => {
        disposed = true;
      });
      await tick();
      assert.equal(disposed, false);
      held.resolve();
      await disposal;
      assert.equal(disposed, true);
      assert(
        !f.calls.some((call) => call.operation === 'stopChat' || call.operation === 'sendChat'),
      );
    } finally {
      clearTimeout(timer);
      held.resolve();
    }
  });

test('an explicit around jump supersedes held navigation without late errors or finally replacing the chosen anchor', async (t) => {
  const f = await transcriptController(t);
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
    const old = f.controller.jumpToEntry('e320');
    await entered.promise;
    await f.controller.jumpToEntry('e100');
    await old;
    const current = f.controller.getSnapshot();
    assert.equal(current.transcript.view.anchor!.key, 'entry:e100');
    assert.equal(current.transcript.loading, false);
    held.resolve();
    await tick();
    assert.equal(f.controller.getSnapshot(), current);
  } finally {
    held.resolve();
  }
});

test('a held continuation reports its actual retained offset after another selection evicts its cached prefix', async (t) => {
  const f = await transcriptController(t, 1),
    source = f.entries[0].transcript!.source;
  const data = ['x'.repeat(70000), ...Array.from({ length: 128 }, () => 'small')];
  f.fixture.sources.set(JSON.stringify(source), { source, data });
  const chosen = selection(part('m0.b0', data[0]));
  await f.controller.loadTranscriptPart(source, chosen);
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
    const reading = f.controller.loadTranscriptPart(source, chosen);
    await entered.promise;
    for (let index = 1; index < data.length; index++)
      await f.controller.loadTranscriptPart(source, selection(part('m0.b' + index, data[index])));
    held.resolve();
    await reading;
    const content = f.controller
      .getSnapshot()
      .transcript.content.find((value) => value.selection.partId === 'm0.b0')!;
    assert.equal(content.chunks[0].offset, 32768);
    assert.equal(content.retainedFrom, 32768);
    assert.equal(content.loadedBytes, 65536);
  } finally {
    held.resolve();
  }
});

test('terminal onError invalidates completed live hydration even when a local watch omits reconnect status', async (t) => {
  const f = await transcriptController(t, 1);
  const value = live(f.snapshot, 'retained live');
  f.publish(value);
  const source = value.run!.transcript!.source,
    chosen = selection(value.run!.transcript!.parts[0]);
  f.fixture.sources.set(JSON.stringify(source), { source, data: ['retained live'] });
  await f.controller.loadTranscriptManifest(source);
  await f.controller.loadTranscriptPart(source, chosen);
  assert.equal(f.controller.getSnapshot().transcript.content[0].status, 'complete');
  f.fail(new ApplicationError({ code: 'Unauthorized', message: 'authority revoked' }));
  assert.equal(f.controller.getSnapshot().transcript.content[0].status, 'source-changed');
  assert.equal(f.controller.getSnapshot().transcript.manifest!.status, 'source-changed');
  const calls = f.calls.length;
  await f.controller.loadTranscriptPart(source, chosen);
  assert.equal(f.calls.length, calls);
  assert.match(f.controller.getSnapshot().error!, /^Unauthorized:/);
});

test('history traverses every entry backward and forward across summary eviction', async (t) => {
  const f = await transcriptController(t, 2400);
  for (const direction of ['earlier', 'later'] as const) {
    const seen = new Set<string>();
    for (let step = 0; step < 100; step++) {
      const state = f.controller.getSnapshot().transcript;
      for (const entry of state.entries) seen.add(entry.id);
      assert.equal(state.error, null);
      assertBounds(state);
      assert.deepEqual(
        state.entries.map((entry) => entry.id),
        f.entries
          .filter((entry) => state.entries.some((value) => value.id === entry.id))
          .map((entry) => entry.id),
      );
      if (!state[direction]) break;
      await (direction === 'earlier' ? f.controller.showEarlier() : f.controller.showLater());
    }
    assert.equal(seen.size, 2400, direction);
    const state = f.controller.getSnapshot().transcript;
    assert.equal(state[direction], false);
    assert.equal(state.atLatest, direction === 'later');
    assert.equal(state[direction === 'earlier' ? 'later' : 'earlier'], true);
  }
  assert.equal(f.controller.getSnapshot().transcript.entries.at(-1)!.id, 'e2399');
});

function appendTranscriptEntries(
  f: Awaited<ReturnType<typeof transcriptController>>,
  count: number,
) {
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
  const f = await transcriptController(t, 64);
  appendTranscriptEntries(f, 128);
  f.publish({
    ...f.snapshot,
    entries: f.entries.slice(-32).reverse(),
    transcriptBoundary: f.entries.at(-1)!.id,
    olderCursor: '96',
  });
  for (const direction of ['earlier', 'later'] as const) {
    const seen = new Set<string>();
    for (let step = 0; step < 40; step++) {
      const state = f.controller.getSnapshot().transcript;
      state.entries.forEach((entry) => seen.add(entry.id));
      assert.equal(state.error, null);
      assert.deepEqual(
        state.entries.map((entry) => entry.id),
        f.entries
          .filter((entry) => state.entries.some((value) => value.id === entry.id))
          .map((entry) => entry.id),
      );
      if (!state[direction]) break;
      await (direction === 'earlier' ? f.controller.showEarlier() : f.controller.showLater());
    }
    assert.equal(seen.size, 128, direction);
    assert.equal(f.controller.getSnapshot().transcript[direction], false);
  }
  assert.equal(f.controller.getSnapshot().transcript.atLatest, true);
});

test('disjoint latest updates preserve an around-entry anchor and bridge to later history', async (t) => {
  const f = await transcriptController(t, 64);
  await f.controller.jumpToEntry('e16');
  f.controller.setTranscriptView({
    anchor: { key: 'entry:e16', partId: 'm0.b0', offset: -13 },
    expanded: ['thought'],
  });
  const before = f.controller.getSnapshot().transcript,
    reads = f.calls.length;
  appendTranscriptEntries(f, 640);
  f.publish({
    ...f.snapshot,
    entries: f.entries.slice(-32).reverse(),
    transcriptBoundary: f.entries.at(-1)!.id,
    olderCursor: '608',
  });
  assert.equal(f.controller.getSnapshot().transcript.entries, before.entries);
  assert.deepEqual(f.controller.getSnapshot().transcript.view, before.view);
  assert.equal(f.calls.length, reads);
  await f.controller.showEarlier();
  const seen = new Set<string>();
  for (let step = 0; step < 100; step++) {
    const state = f.controller.getSnapshot().transcript;
    state.entries.forEach((entry) => seen.add(entry.id));
    assert.equal(state.error, null);
    assertBounds(state);
    if (!state.later) break;
    await f.controller.showLater();
  }
  assert.equal(seen.size, 640);
  assert.equal(f.controller.getSnapshot().transcript.atLatest, true);
});

test('held older navigation keeps its captured window through a disjoint latest snapshot', async (t) => {
  const f = await transcriptController(t, 64);
  const entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<void>();
  let upper: string | undefined;
  f.handlers.set('getChatHistoryAround', async (_input, _signal, fallback) => {
    const page = fallback() as { upperEntryId: string };
    if (!upper) {
      upper = page.upperEntryId;
      entered.resolve();
      await held.promise;
    }
    return page;
  });
  try {
    const reading = f.controller.showEarlier();
    await entered.promise;
    assert.equal(upper, 'e63');
    appendTranscriptEntries(f, 128);
    f.publish({
      ...f.fixture.snapshot,
      entries: f.entries.slice(-32).reverse(),
      transcriptBoundary: f.entries.at(-1)!.id,
      olderCursor: '96',
    });
    held.resolve();
    await reading;
    const seen = { earlier: new Set<string>(), later: new Set<string>() };
    for (const direction of ['earlier', 'later'] as const) {
      for (let step = 0; step < 80; step++) {
        const state = f.controller.getSnapshot().transcript;
        state.entries.forEach((entry) => seen[direction].add(entry.id));
        const positions = state.entries.map((entry) =>
          f.entries.findIndex((value) => value.id === entry.id),
        );
        assert.deepEqual(
          positions,
          [...positions].sort((a, b) => a - b),
          'canonical window order',
        );
        assert.equal(state.error, null);
        assertBounds(state);
        if (!state[direction]) break;
        await (direction === 'earlier' ? f.controller.showEarlier() : f.controller.showLater());
      }
      assert.equal(f.controller.getSnapshot().transcript[direction], false);
    }
    assert.deepEqual(
      seen.earlier,
      new Set(f.entries.slice(0, 64).map((entry) => entry.id)),
      'old upper bound stays fixed',
    );
    assert.equal(seen.later.size, 128);
    assert.equal(f.controller.getSnapshot().transcript.atLatest, true);
    assert.equal(f.controller.getSnapshot().snapshot!.transcriptBoundary, f.entries.at(-1)!.id);
  } finally {
    held.resolve();
  }
});

test('older navigation captures historical mode before a loading subscriber publishes a new boundary', async (t) => {
  const f = await transcriptController(t, 64);
  let published = false;
  const off = f.controller.subscribe(() => {
    if (published || !f.controller.getSnapshot().transcript.loading) return;
    published = true;
    appendTranscriptEntries(f, 128);
    f.publish({
      ...f.fixture.snapshot,
      entries: f.entries.slice(-32).reverse(),
      transcriptBoundary: f.entries.at(-1)!.id,
      olderCursor: '96',
    });
  });
  try {
    await f.controller.showEarlier();
    assert(published);
    const request = f.calls.find((call) => call.operation === 'getChatHistoryAround')!.input as {
      entryId: string;
    };
    assert.equal(request.entryId, 'e32');
    assert.equal(f.controller.getSnapshot().transcript.atLatest, false);
    assert(
      f.controller
        .getSnapshot()
        .transcript.entries.every(
          (entry) => f.entries.indexOf(f.entries.find((value) => value.id === entry.id)!) < 64,
        ),
    );
    assert.equal(f.controller.getSnapshot().transcript.error, null);
  } finally {
    off();
  }
});

for (const replacement of ['around', 'latest'] as const)
  for (const oldOutcome of ['success', 'error'] as const)
    test(`${replacement} supersedes held older navigation without late ${oldOutcome} changing its loading or failure`, async (t) => {
      const f = await transcriptController(t, 64);
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
            throw new ApplicationError({ code: 'Unavailable', message: 'obsolete history failed' });
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
        const old = f.controller.showEarlier();
        await oldEntered.promise;
        appendTranscriptEntries(f, 128);
        f.publish({
          ...f.fixture.snapshot,
          entries: f.entries.slice(-32).reverse(),
          transcriptBoundary: f.entries.at(-1)!.id,
          olderCursor: '96',
        });
        const current =
          replacement === 'around' ? f.controller.jumpToEntry('e10') : f.controller.jumpToLatest();
        await newEntered.promise;
        const loading = f.controller.getSnapshot();
        await old;
        assert.equal(
          f.controller.getSnapshot(),
          loading,
          'old cancellation/finally cannot clear newer loading',
        );
        assert.equal(loading.transcript.loading, true);
        newHeld.reject(
          new ApplicationError({ code: 'Unavailable', message: 'newer navigation failed' }),
        );
        await current;
        const failed = f.controller.getSnapshot();
        assert.equal(failed.transcript.loading, false);
        assert.match(failed.transcript.error!, /newer navigation failed/);
        oldHeld.resolve();
        await tick();
        assert.equal(
          f.controller.getSnapshot(),
          failed,
          'old settlement cannot clear newer error or merge its page',
        );
      } finally {
        oldHeld.resolve();
        newHeld.resolve();
      }
    });

test('held anchor restoration preserves its upper bound and relative offset through a disjoint snapshot', async (t) => {
  const f = await transcriptController(t, 64);
  f.controller.setTranscriptView({
    anchor: { key: 'entry:e16', partId: 'm0.b0', offset: -9 },
    expanded: ['thought'],
  });
  await f.controller.detach();
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
    const restoring = f.controller.start();
    await entered.promise;
    appendTranscriptEntries(f, 128);
    f.publish({
      ...f.fixture.snapshot,
      entries: f.entries.slice(-32).reverse(),
      transcriptBoundary: f.entries.at(-1)!.id,
      olderCursor: '96',
    });
    held.resolve();
    await restoring;
    const state = f.controller.getSnapshot().transcript;
    assert.equal(upper, 'e63');
    assert.deepEqual(state.view, {
      anchor: { key: 'entry:e16', partId: 'm0.b0', offset: -9 },
      expanded: ['thought'],
    });
    assert(
      state.entries.every((entry) => f.entries.findIndex((value) => value.id === entry.id) < 64),
    );
    assert.equal(state.atLatest, false);
    assert.equal(state.error, null);
    assert(state.later);
    for (let step = 0; step < 30 && f.controller.getSnapshot().transcript.later; step++)
      await f.controller.showLater();
    assert.equal(f.controller.getSnapshot().transcript.atLatest, true);
    assert.equal(f.controller.getSnapshot().transcript.entries.at(-1)!.id, f.entries.at(-1)!.id);
    assert.equal(f.controller.getSnapshot().transcript.error, null);
  } finally {
    held.resolve();
  }
});

test('navigation at an unavailable boundary or failed observation does not move the window or clear errors', async (t) => {
  const f = await transcriptController(t, 64);
  const latest = f.controller.getSnapshot(),
    calls = f.calls.length;
  await f.controller.showLater();
  assert.equal(f.controller.getSnapshot(), latest);
  assert.equal(f.calls.length, calls);
  await f.controller.jumpToEntry('e0');
  const beginning = f.controller.getSnapshot(),
    reads = f.calls.length;
  await f.controller.showEarlier();
  assert.equal(f.controller.getSnapshot(), beginning);
  assert.equal(f.calls.length, reads);
  f.fail(new ApplicationError({ code: 'Unauthorized', message: 'observation authority revoked' }));
  const failed = f.controller.getSnapshot();
  await f.controller.showEarlier();
  await f.controller.showLater();
  await f.controller.jumpToEntry('e10');
  await f.controller.jumpToLatest();
  assert.equal(f.controller.getSnapshot(), failed);
  assert.equal(f.calls.length, reads);
  assert.match(failed.transcript.error!, /observation authority revoked/);
});

test('large part manifests release descriptors before evicting navigable history', async (t) => {
  const f = await transcriptController(t, 640);
  const source = f.entries[320].transcript!.source;
  f.fixture.sources.set(JSON.stringify(source), {
    source,
    data: Array.from({ length: 300 }, () => 'part'),
  });
  f.entries[320].transcript = {
    source,
    parts: Array.from({ length: 4 }, (_, index) => part(`m0.b${index}`, 'part')),
    nextCursor: '4',
    thinking: 'none',
  };
  await f.controller.jumpToEntry('e320');
  for (let index = 0; index < 10; index++) await f.controller.loadTranscriptManifest(source);
  const seen = new Set<string>();
  for (let index = 0; index < 100; index++) {
    const state = f.controller.getSnapshot().transcript;
    for (const entry of state.entries) seen.add(entry.id);
    assert.equal(state.error, null);
    assertBounds(state);
    if (!state.earlier) break;
    await f.controller.showEarlier();
  }
  assert.deepEqual(
    f.entries.slice(0, 321).filter((entry) => !seen.has(entry.id)),
    [],
  );
});

test('a delayed initial read must not supersede a newer explicit Latest navigation', async (t) => {
  const f = await transcriptController(t, 640);
  f.controller.setTranscriptView({ anchor: { key: 'entry:e100', offset: -4 }, expanded: [] });
  await f.controller.detach();
  const firstEntered = Promise.withResolvers<void>();
  const firstGate = Promise.withResolvers<void>();
  let requests = 0;
  f.handlers.set('getChat', async (_input, _signal, fallback) => {
    const reply = fallback();
    if (++requests === 1) {
      firstEntered.resolve();
      await firstGate.promise;
    }
    return reply;
  });
  try {
    const starting = f.controller.start();
    await firstEntered.promise;
    f.fixture.publish(f.fixture.snapshot);
    // The watched snapshot reaches the live edge, so Latest needs no read of its own.
    await f.controller.jumpToLatest();
    assert.equal(requests, 1);
    firstGate.resolve();
    await starting;
    await tick();
    const state = f.controller.getSnapshot().transcript;
    assert.equal(state.atLatest, true);
    assert.equal(state.view.anchor, null);
    assert.equal(state.entries.at(-1)?.id, 'e639');
  } finally {
    firstGate.resolve();
  }
});

test('later navigation at the newer edge always advances the retained history', async (t) => {
  const f = await transcriptController(t, 2400);
  for (let i = 0; i < 100 && f.controller.getSnapshot().transcript.earlier; i++)
    await f.controller.showEarlier();
  for (let i = 0; i < 100 && f.controller.getSnapshot().transcript.later; i++) {
    const before = f.controller.getSnapshot().transcript.entries.map((e) => e.id);
    await f.controller.showLater();
    const after = f.controller.getSnapshot().transcript;
    if (JSON.stringify(before) === JSON.stringify(after.entries.map((e) => e.id))) {
      assert.fail('Later returned the same history while later remained true');
    }
  }
});

for (const outcome of ['success', 'error'] as const)
  test(`new view capture fences held startup restoration ${outcome}`, async (t) => {
    const f = await transcriptController(t, 640);
    f.controller.setTranscriptView({ anchor: { key: 'entry:e100', offset: -4 }, expanded: [] });
    await f.controller.detach();
    const entered = Promise.withResolvers<void>(),
      held = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    f.handlers.set('getChatHistoryAround', async (_input, abort, fallback) => {
      signal = abort;
      const reply = fallback();
      entered.resolve();
      await held.promise;
      if (outcome === 'error')
        throw new ApplicationError({ code: 'Unavailable', message: 'obsolete restore failed' });
      return reply;
    });
    try {
      const starting = f.controller.start();
      await entered.promise;
      const before = f.controller.getSnapshot().transcript.entries;
      assert(before.some((entry) => entry.id === 'e620'));
      const view = { anchor: { key: 'entry:e620', offset: -21 }, expanded: ['new'] };
      f.controller.setTranscriptView(view);
      assert.equal(signal?.aborted, true);
      held.resolve();
      await starting;
      await tick();
      const after = f.controller.getSnapshot().transcript;
      assert.deepEqual(after.entries, before);
      assert.deepEqual(after.view, view);
      assert.equal(after.loading, false);
      assert.equal(after.error, null);
    } finally {
      held.resolve();
    }
  });

test('capture before delayed initial read cancels restoration without losing older history', async (t) => {
  const f = await transcriptController(t, 640);
  f.controller.setTranscriptView({ anchor: { key: 'entry:e100', offset: -4 }, expanded: [] });
  await f.controller.detach();
  const entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<void>();
  f.handlers.set('getChat', async (_raw, _signal, fallback) => {
    const reply = fallback();
    entered.resolve();
    await held.promise;
    return reply;
  });
  try {
    const starting = f.controller.start();
    await entered.promise;
    f.fixture.publish(f.fixture.snapshot);
    f.controller.setTranscriptView({ anchor: { key: 'entry:e620', offset: -21 }, expanded: [] });
    held.resolve();
    await starting;
    await tick();
    const state = f.controller.getSnapshot().transcript;
    assert.equal(state.earlier, true);
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const s = f.controller.getSnapshot().transcript;
      s.entries.forEach((e) => seen.add(e.id));
      if (!s.earlier) break;
      await f.controller.showEarlier();
    }
    assert.equal(seen.size, 640);
  } finally {
    held.resolve();
  }
});

test('a reconnecting snapshot cancels an evicted live part read without an error or re-adding it', async (t) => {
  const f = await transcriptController(t, 200);
  const running = live(f.snapshot, 'live text');
  f.publish(running);
  const transcript = running.run!.transcript!;
  const held = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  f.handlers.set('getChatTranscriptContent', async (raw, abort, fallback) => {
    if ((raw as { source: ChatTranscriptSource }).source.kind !== 'live') return fallback();
    signal = abort;
    await held.promise;
    throw new ApplicationError({ code: 'Unavailable', message: 'late live failure' });
  });
  const pending = f.controller.loadTranscriptPart(
    transcript.source,
    selection(transcript.parts[0]),
  );
  for (let i = 0; i < 100 && !signal; i++) await tick();
  assert(signal);
  // Filling the cache with other selections evicts the loading live part.
  for (const entry of f.entries.slice(0, 128))
    await f.controller.loadTranscriptPart(
      entry.transcript!.source,
      selection(entry.transcript!.parts[0]),
    );
  const hasLive = (state: TranscriptState) =>
    state.content.some((content) => content.source.kind === 'live');
  assert.equal(hasLive(f.controller.getSnapshot().transcript), false);
  f.publish({ ...running, observationStatus: 'reconnecting' });
  assert.equal(signal.aborted, true);
  held.resolve();
  await pending;
  await tick();
  const state = f.controller.getSnapshot();
  assert.equal(state.transcript.error, null);
  assert.equal(state.error, null);
  assert.equal(hasLive(state.transcript), false);
});
