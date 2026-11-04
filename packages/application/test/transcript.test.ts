import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApplicationError } from '@moonbase/contracts/errors';
import {
  iterateTranscriptSource,
  makeTranscriptReader,
  transcriptLimits,
} from '@moonbase/application/chat';
import type { ChatSnapshot, ChatTranscriptSource } from '@moonbase/contracts/chat';
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
  const f = await transcriptController(t);
  const seen = new Set<string>();
  for (let page = 0; page < 25; page++) {
    const state = f.controller.getSnapshot().transcript;
    state.entries.forEach((entry) => seen.add(entry.id));
    assert(state.entries.length <= 128);
    assert(state.retained.summaries <= 256);
    assert(state.retained.summaryBytes <= transcriptLimits.summaryBytes);
    assert.deepEqual(
      state.entries.map((entry) => Number(entry.id.slice(1))),
      state.entries.map((entry) => Number(entry.id.slice(1))).sort((a, b) => a - b),
    );
    if (!state.earlier) break;
    await f.controller.older();
    assert.equal(f.controller.getSnapshot().transcript.error, null);
  }
  assert.equal(seen.size, 640);
  assert.equal(f.controller.getSnapshot().transcript.entries[0].id, 'e0');
  await f.controller.jumpToEntry('e320');
  let state = f.controller.getSnapshot().transcript;
  assert(state.entries.some((entry) => entry.id === 'e320'));
  assert(state.earlier && state.later);
  await f.controller.older();
  await f.controller.later();
  state = f.controller.getSnapshot().transcript;
  assert(state.entries.some((entry) => entry.id === 'e320'));
  f.publish({ ...f.snapshot, state: 'running', message: 'latest changed' });
  assert.equal(
    f.controller.getSnapshot().transcript.entries,
    state.entries,
    'live state does not replace historical window',
  );
  await f.controller.jumpToLatest();
  assert.equal(f.controller.getSnapshot().transcript.entries.at(-1)?.id, 'e639');
  assert(f.calls.filter((call) => call.operation === 'getChatHistoryAround').length > 2);
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

test('selected manifest hydration advances and retries errors; content validates exact echoes, offsets and terminal proof', async (t) => {
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
  for (const corrupt of ['offset', 'target', 'revision', 'terminal'] as const) {
    f.handlers.set('getChatTranscriptContent', async (_input, _signal, fallback) => {
      const reply = structuredClone(fallback()) as ContentReply;
      if (corrupt === 'offset') reply.offset--;
      if (corrupt === 'target') reply.source.target.actorId = 'foreign';
      if (corrupt === 'revision') reply.selection.revision = digest('foreign');
      if (corrupt === 'terminal') reply.nextCursor = null;
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
  assert(view.retained.contentBytes <= transcriptLimits.contentBytes);
  assert(view.content[0].retainedFrom > 0, 'oversized active selection is not exempt from budget');
  assert.equal(view.content[0].loadedBytes, data.length);
  assert.equal(await collect(f.controller.iterateTranscript(source, { selection: chosen })), data);
});

test('summary byte and record budgets include hydrated descriptors and envelopes; complete iteration passes descriptor eviction', async (t) => {
  const f = await transcriptController(t, 1);
  const source = f.entries[0].transcript!.source,
    data = Array.from({ length: 300 }, () => 'b'.repeat(256));
  f.fixture.sources.set(JSON.stringify(source), { source, data });
  for (let i = 0; i < 10; i++) await f.controller.loadTranscriptManifest(source);
  const state = f.controller.getSnapshot().transcript;
  assert(state.retained.summaries <= 256);
  assert(state.manifest!.omittedParts > 0);
  assert.equal(await collect(f.controller.iterateTranscript(source)), data.join(''));
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

test('stale/replaced/recovered/finalized live sources cannot authorize hydration or complete reads; fixed prefixes exclude later appends', async (t) => {
  const f = await transcriptController(t, 1);
  let value = live(f.snapshot, 'prefix');
  const source = value.run!.transcript!.source,
    chosen = selection(value.run!.transcript!.parts[0]);
  f.fixture.sources.set(JSON.stringify(source), { source, data: ['prefix'] });
  f.publish(value);
  await f.controller.loadTranscriptPart(source, chosen);
  value = live(value, 'prefix APPENDED');
  f.publish(value);
  f.fixture.sources.set(JSON.stringify(source), { source, data: ['prefix APPENDED'] });
  assert.equal(
    await collect(f.controller.iterateTranscript(source, { selection: chosen })),
    'prefix',
  );
  f.fixture.sources.set(JSON.stringify(source), { source, data: ['replacement'] });
  await assert.rejects(
    collect(f.controller.iterateTranscript(source, { selection: chosen })),
    (error) => ApplicationError.is(error) && error.code === 'Conflict',
  );
  f.publish({ ...value, observationStatus: 'reconnecting' });
  const calls = f.calls.length;
  await f.controller.loadTranscriptPart(source, chosen, true);
  await assert.rejects(collect(f.controller.iterateTranscript(source, { selection: chosen })));
  assert.equal(f.calls.length, calls);
  value = live(value, 'recovery', digest('replacement incarnation'));
  f.publish(value);
  await assert.rejects(collect(f.controller.iterateTranscript(source, { selection: chosen })));
  f.publish({
    ...value,
    state: 'idle',
    run: null,
    entries: [
      ...value.entries,
      {
        ...value.entries[0],
        id: 'distinct-identical-partial',
        transcript: {
          ...value.entries[0].transcript!,
          source: { kind: 'entry', target: f.target, entryId: 'distinct-identical-partial' },
        },
      },
    ],
    transcriptBoundary: 'distinct-identical-partial',
  });
  assert.equal(f.controller.getSnapshot().transcript.entries.length, 2);
  await assert.rejects(collect(f.controller.iterateTranscript(source, { selection: chosen })));
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

test('escaped summary data evicts at two MiB before the row limit without losing earlier/later navigation', async (t) => {
  const f = await transcriptController(t, 160);
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
      upperEntryId: 'e159',
      entries: f.entries.slice(lo, hi).reverse(),
      olderCursor: lo ? JSON.stringify({ lo: Math.max(0, lo - 8), hi: lo }) : null,
      newerCursor: hi < 160 ? JSON.stringify({ lo: hi, hi: Math.min(160, hi + 8) }) : null,
    };
  });
  for (let i = 0; i < 25 && f.controller.getSnapshot().transcript.earlier; i++) {
    await f.controller.older();
    const state = f.controller.getSnapshot().transcript;
    assert.equal(state.error, null);
    assert(state.retained.summaryBytes <= transcriptLimits.summaryBytes);
    assert(state.retained.summaries <= 256);
  }
  const state = f.controller.getSnapshot().transcript;
  assert.equal(state.entries[0].id, 'e0');
  assert(state.entries.length < 128, 'escaped bytes, not only row count, enforce retention');
  await f.controller.jumpToEntry('e120');
  assert(f.controller.getSnapshot().transcript.entries.some((entry) => entry.id === 'e120'));
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
    anchor: { entryId: 'e0', offset: -2 },
    expanded: Array.from({ length: 400 }, (_, i) => 'expanded-' + i),
  });
  assert.equal(f.controller.getSnapshot().transcript.view.expanded.length, 128);
  const { TranscriptViewMemory } = await import('@moonbase/application/chat');
  const memory = new TranscriptViewMemory();
  for (let i = 0; i < 70; i++)
    memory.set(
      'backend',
      { ...f.target, conversationId: 'conversation-' + i },
      { anchor: { entryId: 'e0', offset: 0 }, expanded: [] },
    );
  assert.equal(
    memory.get('backend', { ...f.target, conversationId: 'conversation-0' }).anchor,
    null,
  );
  assert.equal(
    memory.get('backend', { ...f.target, conversationId: 'conversation-69' }).anchor!.entryId,
    'e0',
  );
});

test('complete iteration rejects a manifest continuation cycle and a held live result after observation becomes stale', async (t) => {
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
  await assert.rejects(collect(f.controller.iterateTranscript(source)), /advance/);
  f.handlers.clear();
  const value = live(f.snapshot, 'live');
  f.publish(value);
  const liveSource = value.run!.transcript!.source,
    selected = selection(value.run!.transcript!.parts[0]);
  f.fixture.sources.set(JSON.stringify(liveSource), { source: liveSource, data: ['live'] });
  const entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<void>();
  f.handlers.set('getChatTranscriptContent', async (_raw, _signal, fallback) => {
    entered.resolve();
    const result = fallback();
    await held.promise;
    return result;
  });
  const progress: number[] = [];
  const reading = collect(
    f.controller.iterateTranscript(liveSource, {
      selection: selected,
      onProgress: (state) => progress.push(state.bytes),
    }),
  );
  await entered.promise;
  f.publish({ ...value, observationStatus: 'reconnecting' });
  assert(f.calls.at(-1)!.signal!.aborted);
  held.resolve();
  await assert.rejects(reading);
  assert.deepEqual(progress, []);
});

test('changed entry descriptors invalidate relevant hydration; explicit refresh reattaches a failed observation', async (t) => {
  const f = await transcriptController(t, 1);
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

test('iterator creation captures the exact owner/source before first pull, including A to B to A replacement', async (t) => {
  const f = await transcriptController(t, 1);
  const source = structuredClone(f.entries[0].transcript!.source);
  const iterator = f.controller.iterateTranscript(source);
  if (source.kind === 'entry') source.entryId = 'mutated';
  await f.controller.select(f.target);
  await assert.rejects(
    collect(iterator),
    (error) => ApplicationError.is(error) && error.code === 'Cancelled',
  );
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
    assert.equal(current.transcript.view.anchor!.entryId, 'e100');
    assert.equal(current.transcript.loading, false);
    held.resolve();
    await tick();
    assert.equal(f.controller.getSnapshot(), current);
  } finally {
    held.resolve();
  }
});

test('held live content cannot complete after an observed same-incarnation prefix replacement', async (t) => {
  const f = await transcriptController(t, 1);
  const initial = live(f.snapshot, 'prefix');
  f.publish(initial);
  const source = initial.run!.transcript!.source;
  f.fixture.sources.set(JSON.stringify(source), { source, data: ['prefix'] });
  const entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<void>();
  f.handlers.set('getChatTranscriptContent', async (_input, _signal, fallback) => {
    const result = fallback();
    entered.resolve();
    await held.promise;
    return result;
  });
  const reading = collect(
    f.controller.iterateTranscript(source, {
      selection: selection(initial.run!.transcript!.parts[0]),
    }),
  );
  await entered.promise;
  f.publish(live(initial, 'REPLACED'));
  held.resolve();
  await assert.rejects(reading, (error) => ApplicationError.is(error) && error.code === 'Conflict');
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
  await assert.rejects(collect(f.controller.iterateTranscript(source, { selection: chosen })));
  assert.match(f.controller.getSnapshot().error!, /^Unauthorized:/);
});
