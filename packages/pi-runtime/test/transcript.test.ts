import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  Harness,
  LiveDoc,
  GenerationTask,
  ToolTask,
  hook,
  createRegistry,
  defineExtension,
  defineTool,
  type ConversationId,
  type EntryId,
} from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Type } from 'typebox';
import type {
  ChatClient,
  ChatTranscriptSource,
  ChatTranscriptPart,
} from '@moonbase/contracts/chat';
import { fixture, until, session } from './runtime-fixture.ts';

async function manifest(client: ChatClient, source: ChatTranscriptSource) {
  const parts: ChatTranscriptPart[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.command('getChatTranscriptContent', {
      source,
      ...(cursor ? { cursor } : {}),
    });
    assert.equal(page.kind, 'manifest');
    if (page.kind !== 'manifest') throw Error();
    assert.deepEqual(page.source, source);
    assert.equal(page.cursor, cursor ?? null);
    assert(page.parts.length <= 32);
    assert(Buffer.byteLength(JSON.stringify(page)) < 256 * 1024);
    parts.push(...page.parts);
    assert.notEqual(page.nextCursor, cursor);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return parts;
}
async function content(client: ChatClient, source: ChatTranscriptSource, part: ChatTranscriptPart) {
  const selection = { partId: part.partId, bytes: part.bytes, revision: part.revision };
  const chunks: Buffer[] = [];
  let cursor: string | undefined,
    offset = 0;
  do {
    const page = await client.command('getChatTranscriptContent', {
      source,
      selection,
      ...(cursor ? { cursor } : {}),
    });
    assert.equal(page.kind, 'content');
    if (page.kind !== 'content') throw Error();
    assert.deepEqual(page.source, source);
    assert.deepEqual(page.selection, selection);
    assert.equal(page.offset, offset);
    assert.equal(page.cursor, cursor ?? null);
    const chunk = Buffer.from(page.data, page.encoding === 'utf8' ? 'utf8' : 'base64');
    assert(chunk.length <= 32 * 1024);
    assert(Buffer.byteLength(JSON.stringify({ ok: true, value: page })) <= 256 * 1024);
    chunks.push(chunk);
    offset += chunk.length;
    assert.notEqual(page.nextCursor, cursor);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(offset, part.bytes);
  return Buffer.concat(chunks);
}
function captureHarness(t: TestContext) {
  let harness!: Harness;
  const original = Harness.open;
  t.mock.method(
    Harness,
    'open',
    async (...args: Parameters<typeof original>) => (harness = await original(...args)),
  );
  return () => harness;
}

test('all retained blocks, large escaped Unicode/JSON/patch/image content and 1,100 entries reconstruct without migration or skips', async (t) => {
  const getHarness = captureHarness(t),
    f = await fixture(t),
    target = await f.create(),
    other = await f.create('other');
  assert.deepEqual((await f.client.command('getChatHost', { host: session.host })).features, [
    'transcript-v1',
  ]);
  const text = '😀\\"\n\u0000\u0001'.repeat(70000);
  const args = { content: text },
    patch = '--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+' + text;
  const image = Buffer.alloc(700001, 71);
  const retained: string[] = [];
  const entry = await getHarness().commit(async (tx) => {
    for (let i = 0; i < 1100; i++) {
      const row = await tx.appendEntry(
        Number(target.conversationId) as ConversationId,
        i % 20 === 0
          ? { kind: 'pi.reset', head: 'self' }
          : { kind: 'pi.user', model: [{ role: 'user', content: 'record ' + i, timestamp: 1 }] },
      );
      retained.push(String(row.id));
    }
    return tx.appendEntry(Number(target.conversationId) as ConversationId, {
      kind: 'pi.assistant',
      model: [
        fauxAssistantMessage([
          ...Array.from({ length: 40 }, (_, i) => ({ type: 'text' as const, text: 'block ' + i })),
          {
            type: 'thinking',
            thinking: 'retained thinking',
            thinkingSignature: 'private-signature',
          },
          {
            type: 'thinking',
            thinking: 'hidden',
            redacted: true,
            thinkingSignature: 'encrypted-signature',
          },
          { type: 'text', text },
          fauxToolCall('write', args),
        ]),
        {
          role: 'toolResult',
          toolCallId: 'orphan',
          toolName: 'edit',
          isError: true,
          content: [
            { type: 'text', text: 'published partial' },
            { type: 'image', data: image.toString('base64'), mimeType: 'image/png' },
          ],
          details: { patch, diff: 'numbered diff', retained: text },
          timestamp: 1,
        },
      ],
    });
  }, context);
  retained.push(String(entry.id));
  const source: ChatTranscriptSource = { kind: 'entry', target, entryId: String(entry.id) };
  const parts = await manifest(f.client, source);
  assert(parts.length > 32);
  assert(!JSON.stringify(parts).includes('signature'));
  assert(parts.some((part) => part.availability === 'redacted'));
  assert.equal(
    (
      await content(
        f.client,
        source,
        parts.find((part) => part.partId === 'm0.b42')!,
      )
    ).toString(),
    text,
  );
  assert.deepEqual(
    JSON.parse(
      (
        await content(
          f.client,
          source,
          parts.find((part) => part.kind === 'arguments')!,
        )
      ).toString(),
    ),
    args,
  );
  assert.equal(
    (
      await content(
        f.client,
        source,
        parts.find((part) => part.kind === 'patch')!,
      )
    ).toString(),
    patch,
  );
  assert.deepEqual(
    await content(
      f.client,
      source,
      parts.find((part) => part.kind === 'image')!,
    ),
    image,
  );
  const selected = parts.find((part) => part.kind === 'patch')!;
  const selection = { partId: selected.partId, bytes: selected.bytes, revision: selected.revision };
  const first = await f.client.command('getChatTranscriptContent', { source, selection });
  assert(first.kind === 'content' && first.nextCursor);
  for (const wrong of [
    { source: { ...source, target: other }, selection },
    { source: { ...source, target: { ...target, actorId: 'other' } }, selection },
    {
      source: { ...source, target: { ...target, host: { ...target.host, hostId: 'other' } } },
      selection,
    },
    {
      source: { ...source, target: { ...target, host: { ...target.host, storeId: 'other' } } },
      selection,
    },
    { source, selection: { ...selection, partId: 'missing' } },
    { source, selection: { ...selection, revision: '0'.repeat(64) } },
    { source, cursor: first.nextCursor },
    { source, selection, cursor: first.nextCursor + 'tamper' },
  ])
    await assert.rejects(f.client.command('getChatTranscriptContent', wrong));
  let page = await f.client.command('getChat', { target });
  const seen: string[] = [];
  while (true) {
    seen.push(...page.entries.map((row) => row.id));
    assert(Buffer.byteLength(JSON.stringify(page)) <= 256 * 1024);
    if (!page.olderCursor) break;
    page = {
      ...page,
      ...(await f.client.command('getChatHistory', { target, cursor: page.olderCursor })),
    };
  }
  assert.deepEqual(seen, retained.reverse());
  let around = await f.client.command('getChatHistoryAround', { target, entryId: retained[500] });
  assert(around.olderCursor && around.newerCursor);
  assert(around.entries.some((row) => row.id === retained[500]));
  const originalAround = around;
  const window = new Set(around.entries.map((row) => row.id));
  while (around.olderCursor) {
    around = await f.client.command('getChatHistoryAround', {
      target,
      entryId: retained[500],
      cursor: around.olderCursor,
    });
    around.entries.forEach((row) => window.add(row.id));
  }
  around = originalAround;
  while (around.newerCursor) {
    around = await f.client.command('getChatHistoryAround', {
      target,
      entryId: retained[500],
      cursor: around.newerCursor,
    });
    around.entries.forEach((row) => window.add(row.id));
  }
  assert.equal(window.size, retained.length);
  await assert.rejects(
    f.client.command('getChatHistoryAround', {
      target: other,
      entryId: source.entryId,
      cursor: originalAround.olderCursor!,
    }),
  );
  await f.restart();
  const after = await manifest(f.client, source);
  assert.deepEqual(after, parts);
  assert.equal(
    (
      await content(
        f.client,
        source,
        after.find((part) => part.kind === 'patch')!,
      )
    ).toString(),
    patch,
  );
});

test('reused tool call IDs pair by originating assistant/task and retain published failures/details after restart', async (t) => {
  let sequence = 0;
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: 'pairing',
      tools: [
        defineTool({
          name: 'record',
          description: 'Controlled retained result',
          parameters: Type.Object({}),
          execute: async () => ({
            isError: true,
            output: [{ type: 'text', text: 'result ' + ++sequence }],
            details: { patch: 'patch ' + sequence },
          }),
        }),
      ],
    }),
  );
  const f = await fixture(t, registry),
    target = await f.create();
  f.faux.setResponses([
    fauxAssistantMessage([fauxToolCall('record', {}, { id: 'reused' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('record', {}, { id: 'reused' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Done'),
  ]);
  await f.client.command('sendChat', { target, requestId: 'send', text: 'Run twice' });
  const view = await until(
    () => f.client.command('getChat', { target }),
    (state) => !state.run && state.entries.some((row) => row.text === 'Done'),
  );
  const results = view.entries.filter((row) => row.role === 'tool');
  assert.equal(results.length, 2);
  const calls = [];
  for (const row of results) {
    const parts = await manifest(f.client, row.transcript!.source);
    const part = parts.find((part) => part.kind === 'result')!;
    assert.equal(part.pairing, 'matched');
    assert.equal(part.state, 'failed');
    calls.push(part.call!.entryId);
  }
  assert.notEqual(calls[0], calls[1]);
  await f.restart();
  for (const row of results)
    assert(
      (await manifest(f.client, row.transcript!.source)).some((part) => part.kind === 'patch'),
    );
  f.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall('record', {}, { id: 'duplicate' }),
        fauxToolCall('record', {}, { id: 'duplicate' }),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Duplicates complete'),
  ]);
  await f.client.command('sendChat', {
    target,
    requestId: 'duplicates',
    text: 'Duplicate IDs in one entry',
  });
  const duplicateView = await until(
    () => f.client.command('getChat', { target }),
    (view) => !view.run && view.entries.some((entry) => entry.text === 'Duplicates complete'),
  );
  for (const row of duplicateView.entries.filter((entry) => entry.role === 'tool').slice(0, 2)) {
    const duplicate = (await manifest(f.client, row.transcript!.source)).find(
      (part) => part.kind === 'result',
    )!;
    assert.equal(duplicate.pairing, 'ambiguous');
    assert.equal(duplicate.call, undefined);
  }
});

test('live Copy fixes a prefix and rejects replacement/finalization, while held snapshots retain one coherent history boundary', async (t) => {
  const getHarness = captureHarness(t),
    f = await fixture(t),
    target = await f.create();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  f.faux.setResponses([
    async () => {
      await gate;
      return fauxAssistantMessage('Final');
    },
  ]);
  await f.client.command('sendChat', { target, requestId: 'send', text: 'Hold' });
  await until(
    () => getHarness().snapshot(LiveDoc, Number(target.conversationId) as ConversationId, context),
    (live) => !!live?.generation,
  );
  async function setPartial(text: string) {
    await getHarness().commit(async (tx) => {
      const live = await tx.doc(LiveDoc, Number(target.conversationId) as ConversationId);
      live.generation!.message = JSON.parse(JSON.stringify(fauxAssistantMessage(text)));
    }, context);
  }
  await setPartial('fixed prefix 😀');
  const view = await f.client.command('getChat', { target }),
    source = view.run!.transcript!.source;
  const part = (await manifest(f.client, source))[0];
  await setPartial('fixed prefix 😀 appended later');
  assert.equal((await content(f.client, source, part)).toString(), 'fixed prefix 😀');
  await setPartial('replaced prefix');
  await assert.rejects(content(f.client, source, part), { code: 'Conflict' });
  await setPartial('fixed prefix 😀');
  let held = 0,
    releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const original = getHarness().commit.bind(getHarness());
  t.mock.method(getHarness(), 'commit', async (...args: Parameters<typeof original>) => {
    const value = await original(...args);
    if (held < 2 && value && typeof value === 'object' && 'live' in value && 'boundary' in value) {
      held++;
      await readGate;
    }
    return value;
  });
  const pending = f.client.command('getChat', { target });
  await until(
    async () => held,
    (value) => value === 1,
  );
  const contentFailure = assert.rejects(content(f.client, source, part), { code: 'Conflict' });
  await until(
    async () => held,
    (value) => value === 2,
  );
  release();
  await until(
    () => f.client.command('getChat', { target }),
    (state) => !state.run,
  );
  releaseRead();
  const old = await pending;
  await contentFailure;
  assert(old.run);
  assert(!old.entries.some((row) => row.text === 'Final'));
  assert.equal(old.transcriptBoundary, view.transcriptBoundary);
  await assert.rejects(manifest(f.client, source), { code: 'Conflict' });
});

test('same-attempt restart commits the old partial without treating it as the successor live response', async (t) => {
  const getHarness = captureHarness(t),
    f = await fixture(t, undefined, { tokensPerSecond: 1000 }),
    target = await f.create();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  f.faux.setResponses([
    fauxAssistantMessage('partial '.repeat(2000)),
    async () => {
      await gate;
      return fauxAssistantMessage('Recovered');
    },
  ]);
  await f.client.command('sendChat', { target, requestId: 'recover', text: 'Recover' });
  const old = await until(
    () => f.client.command('getChat', { target }),
    (view) => !!view.run?.transcript?.parts.some((part) => part.kind === 'text' && part.bytes > 0),
  );
  const source = old.run!.transcript!.source;
  assert.equal(source.kind, 'live');
  if (source.kind !== 'live') throw Error();
  await f.restart();
  const next = await until(
    () => f.client.command('getChat', { target }),
    (view) =>
      view.entries.some((entry) =>
        entry.transcript?.parts.some((part) => part.state === 'interrupted'),
      ) && !!view.run?.transcript,
  );
  const successor = next.run!.transcript!.source;
  assert.equal(successor.kind, 'live');
  if (successor.kind !== 'live') throw Error();
  assert.equal(successor.taskId, source.taskId);
  assert.equal(successor.attempt, source.attempt);
  assert.notEqual(successor.incarnation, source.incarnation);
  await assert.rejects(manifest(f.client, source), { code: 'Conflict' });
  const partial = next.entries.find((entry) =>
    entry.transcript?.parts.some((part) => part.state === 'interrupted'),
  )!;
  assert(
    (
      await content(
        f.client,
        partial.transcript!.source,
        partial.transcript!.parts.find((part) => part.kind === 'text')!,
      )
    ).length > 0,
  );
  const raw = await getHarness().commit((tx) => tx.entry(Number(partial.id) as EntryId), context);
  assert(raw?.byTaskId);
  release();
  await until(
    () => f.client.command('getChat', { target }),
    (view) => !view.run,
  );
});

test('scheduler-finalized partial without attribution cannot mix with a held live/history capture or leak its fault', async (t) => {
  let releaseRead = () => {},
    release!: () => void,
    entered = false;
  t.after(() => releaseRead());
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: 'controlled-fault',
      hooks: [
        hook(GenerationTask, {
          afterResponse: async (message) => {
            entered = true;
            await gate;
            message.usage.input = Number.NaN;
            message.errorMessage = 'private-scheduler-canary';
          },
        }),
      ],
    }),
  );
  const getHarness = captureHarness(t),
    f = await fixture(t, registry, { tokensPerSecond: 4000 }),
    target = await f.create();
  f.faux.setResponses([fauxAssistantMessage('retained partial '.repeat(200))]);
  await f.client.command('sendChat', { target, requestId: 'fault', text: 'Fault' });
  await until(async () => entered, Boolean);
  const live = await f.client.command('getChat', { target });
  const source = live.run!.transcript!.source;
  assert(live.run!.transcript!.parts.some((part) => part.bytes > 0));
  let captured = false;
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  t.after(() => releaseRead());
  const original = getHarness().commit.bind(getHarness());
  t.mock.method(getHarness(), 'commit', async (...args: Parameters<typeof original>) => {
    const value = await original(...args);
    if (!captured && value && typeof value === 'object' && 'live' in value && 'boundary' in value) {
      captured = true;
      await readGate;
    }
    return value;
  });
  const pending = f.client.command('getChat', { target });
  await until(async () => captured, Boolean);
  release();
  const final = await until(
    () => f.client.command('getChat', { target }),
    (view) => !view.run && view.state === 'failed',
  );
  releaseRead();
  const previous = await pending;
  assert(previous.run);
  assert.equal(previous.transcriptBoundary, live.transcriptBoundary);
  assert(
    !previous.entries.some((entry) =>
      entry.transcript?.parts.some((part) => part.state === 'interrupted'),
    ),
  );
  const partial = final.entries.find((entry) =>
    entry.transcript?.parts.some((part) => part.state === 'interrupted'),
  )!;
  assert(partial);
  const raw = await original((tx) => tx.entry(Number(partial.id) as EntryId), context);
  assert.equal(raw?.byTaskId, undefined);
  assert(!JSON.stringify(final).includes('private-scheduler-canary'));
  await assert.rejects(manifest(f.client, source), { code: 'Conflict' });
});

test('cancelled read releases its caller, keeps the SDK owned through settlement and leaves Stop/other conversations responsive', async (t) => {
  let release = () => {};
  t.after(() => release());
  const getHarness = captureHarness(t),
    f = await fixture(t),
    target = await f.create(),
    other = await f.create('other');
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  t.after(() => releaseProvider());
  f.faux.setResponses([
    async () => {
      await providerGate;
      return fauxAssistantMessage('Completed');
    },
  ]);
  await f.client.command('sendChat', { target, requestId: 'run', text: 'Running' });
  const view = await until(
    () => f.client.command('getChat', { target }),
    (view) => !!view.run,
  );
  const source = view.entries.find((entry) => entry.role === 'user')!.transcript!.source;
  let held = false,
    closed = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const original = getHarness().commit.bind(getHarness()),
    close = getHarness().close.bind(getHarness());
  t.mock.method(getHarness(), 'commit', async (...args: Parameters<typeof original>) => {
    const value = await original(...args);
    if (
      !held &&
      value &&
      typeof value === 'object' &&
      'id' in value &&
      String(value.id) === (source.kind === 'entry' ? source.entryId : '')
    ) {
      held = true;
      await gate;
    }
    return value;
  });
  t.mock.method(getHarness(), 'close', async (...args: Parameters<typeof close>) => {
    closed = true;
    return close(...args);
  });
  const abort = new AbortController();
  const pending = f.client.command(
    'getChatTranscriptContent',
    { source },
    { signal: abort.signal },
  );
  const rejected = assert.rejects(pending, { code: 'Cancelled' });
  await until(async () => held, Boolean);
  abort.abort();
  await rejected;
  assert.equal((await f.client.command('getChat', { target: other })).state, 'idle');
  const stop = await f.client.command('stopChat', { stop: view.run!.stop, requestId: 'stop' });
  assert(['pending', 'terminal', 'stopped'].includes(stop.outcome));
  let disposed = false;
  const disposal = f.dispose().then(() => {
    disposed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(closed, false);
  assert.equal(disposed, false);
  release();
  releaseProvider();
  await disposal;
  assert(closed);
});

test('live executed arguments, retained tails and interrupted tool evidence stay distinct from requested arguments', async (t) => {
  let release!: () => void,
    entered = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: 'execution',
      hooks: [hook(ToolTask, { beforeTool: () => ({ arguments: { value: 'executed' } }) })],
      tools: [
        defineTool({
          name: 'hold',
          description: 'Controlled progress',
          parameters: Type.Object({ value: Type.String() }),
          execute: async (args, api, ctx) => {
            assert.equal(args.value, 'executed');
            entered = true;
            api.output('retained tail '.repeat(10000));
            await api.details({ patch: 'published partial patch' }, ctx);
            await Promise.race([
              gate,
              new Promise<void>((resolve) => {
                ctx.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
              }),
            ]);
            ctx.abortSignal?.throwIfAborted();
            return { output: [{ type: 'text', text: 'finished' }] };
          },
        }),
      ],
    }),
  );
  const f = await fixture(t, registry),
    target = await f.create();
  f.faux.setResponses([
    fauxAssistantMessage([fauxToolCall('hold', { value: 'requested' }, { id: 'same' })], {
      stopReason: 'toolUse',
    }),
  ]);
  await f.client.command('sendChat', { target, requestId: 'send', text: 'Execute' });
  await until(async () => entered, Boolean);
  const view = await until(
    () => f.client.command('getChat', { target }),
    (view) => !!view.run?.tools[0]?.text,
  );
  const source = view.run!.transcript!.source;
  const parts = await until(
    () => manifest(f.client, source),
    (parts) => parts.some((part) => part.kind === 'details'),
  );
  const executed = parts.find((part) => part.kind === 'executed-arguments')!;
  assert.deepEqual(JSON.parse((await content(f.client, source, executed)).toString()), {
    value: 'executed',
  });
  const tail = parts.find((part) => part.kind === 'result')!;
  assert((tail.droppedBytes ?? 0) > 0);
  assert.equal(tail.pairing, 'matched');
  const callEntry = view.entries.find((entry) => entry.id === tail.call!.entryId)!;
  const requested = (await manifest(f.client, callEntry.transcript!.source)).find(
    (part) => part.kind === 'arguments',
  )!;
  assert.deepEqual(
    JSON.parse((await content(f.client, callEntry.transcript!.source, requested)).toString()),
    { value: 'requested' },
  );
  await f.client.command('stopChat', { stop: view.run!.stop, requestId: 'stop' });
  release();
  const stopped = await until(
    () => f.client.command('getChat', { target }),
    (view) => !view.run,
  );
  const result = stopped.entries.find((entry) => entry.role === 'tool')!;
  const retained = await manifest(f.client, result.transcript!.source);
  assert(retained.some((part) => part.state === 'interrupted'));
  assert(retained.some((part) => part.kind === 'patch'));
  assert(retained.some((part) => part.kind === 'result' && part.text.includes('retained tail')));
  await f.restart();
  assert.deepEqual(await manifest(f.client, result.transcript!.source), retained);
});
