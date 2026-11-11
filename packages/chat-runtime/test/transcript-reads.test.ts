import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  Harness,
  NestedCallDoc,
  createRegistry,
  defineExtension,
  defineTool,
  type ConversationId,
  type EntryRecord,
} from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Type } from 'typebox';
import type {
  ChatClient,
  ChatTranscriptPart,
  ChatTranscriptSource,
} from '@moonbase/contracts/chat';
import { fixture, until } from './runtime-fixture.ts';

async function manifest(client: ChatClient, source: ChatTranscriptSource) {
  const parts: ChatTranscriptPart[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.command('getChatTranscriptContent', {
      source,
      ...(cursor ? { cursor } : {}),
    });
    assert(page.kind === 'manifest');
    parts.push(...page.parts);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return parts;
}
async function content(client: ChatClient, source: ChatTranscriptSource, part: ChatTranscriptPart) {
  const selection = { partId: part.partId, bytes: part.bytes, revision: part.revision };
  const chunks: Buffer[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.command('getChatTranscriptContent', {
      source,
      selection,
      ...(cursor ? { cursor } : {}),
    });
    assert(page.kind === 'content');
    chunks.push(Buffer.from(page.data, page.encoding === 'utf8' ? 'utf8' : 'base64'));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
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
function makeHeldTools(t: TestContext) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const controls: { grow(text: string): void; detail(value: { added: number }): Promise<void> }[] =
    [];
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: 'held-tools',
      tools: [
        defineTool({
          name: 'hold',
          description: 'Publish controlled progress until released',
          // Parallel calls may start in any order, so a call can name its place in `controls`.
          parameters: Type.Object({ index: Type.Optional(Type.Number()) }),
          execute: async ({ index }, api, ctx) => {
            api.output('first ');
            const control = {
              grow: (text: string) => api.output(text),
              detail: (value: { added: number }) => api.details(value, ctx),
            };
            if (index === undefined) controls.push(control);
            else controls[index] = control;
            await Promise.race([
              gate,
              new Promise<void>((resolve) => {
                ctx.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
              }),
            ]);
            return { output: [{ type: 'text', text: 'held done' }] };
          },
        }),
        defineTool({
          name: 'quick',
          description: 'Finish immediately',
          parameters: Type.Object({}),
          execute: async () => ({ output: [{ type: 'text', text: 'quick done' }] }),
        }),
      ],
    }),
  );
  return { registry, controls, release: () => release() };
}

test('live manifest cursors survive growing running output and appended parts, not parts inserted before them', async (t) => {
  const held = makeHeldTools(t),
    f = await fixture(t, held.registry),
    target = await f.create();
  f.faux.setResponses([
    fauxAssistantMessage(
      [0, 1, 2].map((i) => fauxToolCall('hold', { index: i }, { id: 'hold-' + i })),
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Released'),
  ]);
  await f.client.command('sendChat', { target, requestId: 'send', text: 'Hold three' });
  await until(
    async () => held.controls.filter(Boolean).length,
    (count) => count === 3,
  );
  const view = await until(
    () => f.client.command('getChat', { target }),
    (view) =>
      !!view.run?.transcript?.nextCursor &&
      view.run.transcript.parts.every((part) => part.kind !== 'result' || !!part.text),
  );
  const embedded = view.run!.transcript!,
    source = embedded.source,
    cursor = embedded.nextCursor!;
  assert.deepEqual(
    embedded.parts.map((part) => part.partId),
    ['tool0.executed', 'tool0.output', 'tool1.executed', 'tool1.output'],
  );
  const firstOutput = embedded.parts[1];
  async function readPage() {
    const page = await f.client.command('getChatTranscriptContent', { source, cursor });
    assert(page.kind === 'manifest');
    return page;
  }
  held.controls[0].grow('grown before the cursor');
  held.controls[2].grow('grown after the cursor');
  await until(
    () => manifest(f.client, source),
    (parts) =>
      parts.some((part) => part.partId === 'tool0.output' && part.bytes > 6) &&
      parts.some((part) => part.partId === 'tool2.output' && part.bytes > 6),
  );
  const page = await readPage();
  assert.deepEqual(
    page.parts.map((part) => part.partId),
    ['tool2.executed', 'tool2.output'],
  );
  assert.equal((await content(f.client, source, firstOutput)).toString(), 'first ');
  const grown = (await manifest(f.client, source)).find((part) => part.partId === 'tool0.output')!;
  assert.equal(
    (await content(f.client, source, grown)).toString(),
    'first grown before the cursor',
  );
  await held.controls[2].detail({ added: 2 });
  const appended = await until(
    () => readPage(),
    (page) => page.parts.some((part) => part.partId === 'tool2.details'),
  );
  assert.deepEqual(
    appended.parts.map((part) => part.partId),
    ['tool2.executed', 'tool2.output', 'tool2.details'],
  );
  assert.equal(appended.nextCursor, null);
  await held.controls[0].detail({ added: 0 });
  await until(
    async () => (await manifest(f.client, source)).map((part) => part.partId),
    (ids) => ids.includes('tool0.details'),
  );
  await assert.rejects(readPage(), { code: 'Conflict' });
  held.release();
});

test('snapshots read nested sources only for their embedded page while manifests read every slot', async (t) => {
  let release!: () => void,
    ready = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: 'many-nested',
      tools: [
        defineTool({
          name: 'parent',
          description: 'Run six retained children, then hold',
          parameters: Type.Object({}),
          execute: async (_, api, ctx) => {
            for (let i = 0; i < 6; i++) await api.executeTool('child', {}, ctx, { key: 'c' + i });
            ready = true;
            await gate;
            return { output: [{ type: 'text', text: 'Parent done' }] };
          },
        }),
        defineTool({
          name: 'child',
          description: 'Return a retained result',
          parameters: Type.Object({}),
          execute: async () => ({ output: [{ type: 'text', text: 'child result' }] }),
        }),
      ],
    }),
  );
  const getHarness = captureHarness(t),
    f = await fixture(t, registry),
    target = await f.create();
  f.faux.setResponses([
    fauxAssistantMessage([fauxToolCall('parent', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Done'),
  ]);
  await f.client.command('sendChat', { target, requestId: 'nested', text: 'Six children' });
  await until(async () => ready, Boolean);
  const harness = getHarness(),
    snapshot = harness.snapshot.bind(harness);
  let reads = 0;
  t.mock.method(harness, 'snapshot', async (...args: Parameters<typeof snapshot>) => {
    if (args[0] === NestedCallDoc) reads++;
    return snapshot(...args);
  });
  const view = await f.client.command('getChat', { target });
  assert.equal(view.run!.transcript!.parts.length, 4);
  assert(view.run!.transcript!.nextCursor);
  assert(reads > 0 && reads < 6, `nested reads: ${reads}`);
  reads = 0;
  const parts = await manifest(f.client, view.run!.transcript!.source);
  assert.equal(new Set(parts.map((part) => part.taskId).filter(Boolean)).size, 7);
  assert(reads >= 6);
  release();
});

/** Counts how often each saved entry record is loaded, by entry ID. */
function countEntryLoads(t: TestContext, harness: Harness) {
  const loads = new Map<string, number>(),
    commit = harness.commit.bind(harness);
  t.mock.method(harness, 'commit', async (...args: Parameters<typeof commit>) => {
    const value = await commit(...args);
    const record = value as EntryRecord | undefined;
    if (record && typeof record === 'object' && 'model' in record && 'conversationId' in record)
      loads.set(String(record.id), (loads.get(String(record.id)) ?? 0) + 1);
    return value;
  });
  return loads;
}
async function readFirstChunks(
  client: ChatClient,
  source: ChatTranscriptSource,
  part: ChatTranscriptPart,
  count: number,
) {
  const selection = { partId: part.partId, bytes: part.bytes, revision: part.revision };
  let cursor: string | undefined;
  for (let i = 0; i < count; i++) {
    const page = await client.command('getChatTranscriptContent', {
      source,
      selection,
      ...(cursor ? { cursor } : {}),
    });
    assert(page.kind === 'content' && page.nextCursor);
    cursor = page.nextCursor;
  }
}

test('chunked reads of a saved entry reuse its built parts without reloading the record', async (t) => {
  const getHarness = captureHarness(t),
    f = await fixture(t),
    target = await f.create(),
    other = await f.create('other');
  const text = 'retained 😀 text '.repeat(20000),
    image = Buffer.alloc(200001, 9);
  const entry = await getHarness().commit(
    (tx) =>
      tx.appendEntry(Number(target.conversationId) as ConversationId, {
        kind: 'pi.assistant',
        model: [
          fauxAssistantMessage([{ type: 'text', text }, fauxToolCall('write', { content: text })]),
          {
            role: 'user',
            timestamp: 1,
            content: [{ type: 'image', data: image.toString('base64'), mimeType: 'image/png' }],
          },
        ],
      }),
    context,
  );
  const loads = countEntryLoads(t, getHarness()),
    id = String(entry.id);
  const source: ChatTranscriptSource = { kind: 'entry', target, entryId: id };
  const parts = await manifest(f.client, source);
  assert.equal(loads.get(id), 1);
  assert.equal((await content(f.client, source, parts[0])).toString(), text);
  assert.deepEqual(JSON.parse((await content(f.client, source, parts[1])).toString()), {
    content: text,
  });
  assert.deepEqual(await content(f.client, source, parts[2]), image);
  assert.deepEqual(await manifest(f.client, source), parts);
  assert.equal(loads.get(id), 1);
  // A cached transcript still authorizes the conversation it belongs to.
  await assert.rejects(manifest(f.client, { ...source, target: other }), {
    code: 'InvalidInput',
  });
  await assert.rejects(content(f.client, { ...source, target: other }, parts[0]), {
    code: 'InvalidInput',
  });
});

test('the saved transcript cache holds entries within its byte budget and evicts beyond it', async (t) => {
  const getHarness = captureHarness(t),
    f = await fixture(t),
    target = await f.create();
  // Two 18 MiB entries each fit the 32 MiB budget, but not together.
  const [first, second] = await getHarness().commit(
    async (tx) => [
      await tx.appendEntry(Number(target.conversationId) as ConversationId, {
        kind: 'pi.user',
        model: [{ role: 'user', content: 'a'.repeat(18 << 20), timestamp: 1 }],
      }),
      await tx.appendEntry(Number(target.conversationId) as ConversationId, {
        kind: 'pi.user',
        model: [{ role: 'user', content: 'b'.repeat(18 << 20), timestamp: 1 }],
      }),
    ],
    context,
  );
  const loads = countEntryLoads(t, getHarness());
  const sources = [first, second].map((entry): ChatTranscriptSource => ({
    kind: 'entry',
    target,
    entryId: String(entry.id),
  }));
  const [firstPart] = await manifest(f.client, sources[0]);
  await readFirstChunks(f.client, sources[0], firstPart, 3);
  assert.equal(loads.get(String(first.id)), 1);
  const [secondPart] = await manifest(f.client, sources[1]);
  await readFirstChunks(f.client, sources[1], secondPart, 3);
  assert.equal(loads.get(String(second.id)), 1);
  await readFirstChunks(f.client, sources[0], firstPart, 1);
  assert.equal(loads.get(String(first.id)), 2);
});

test('empty interrupted, failed and completed messages are labelled in manifests, history and Find', async (t) => {
  const getHarness = captureHarness(t),
    f = await fixture(t),
    target = await f.create();
  const [aborted, failedTool, emptyTool] = await getHarness().commit(
    async (tx) => [
      await tx.appendEntry(Number(target.conversationId) as ConversationId, {
        kind: 'pi.assistant',
        model: [fauxAssistantMessage([], { stopReason: 'aborted' })],
      }),
      await tx.appendEntry(Number(target.conversationId) as ConversationId, {
        kind: 'pi.assistant',
        model: [
          {
            role: 'toolResult',
            toolCallId: 'failed',
            toolName: 'edit',
            isError: true,
            content: [],
            timestamp: 1,
          },
        ],
      }),
      await tx.appendEntry(Number(target.conversationId) as ConversationId, {
        kind: 'pi.assistant',
        model: [
          {
            role: 'toolResult',
            toolCallId: 'empty',
            toolName: 'edit',
            isError: false,
            content: [],
            timestamp: 1,
          },
        ],
      }),
    ],
    context,
  );
  const expected = [
    [aborted, 'assistant', 'interrupted', 'Response interrupted before any content.'],
    [failedTool, 'tool', 'failed', 'Tool failed without output.'],
    [emptyTool, 'tool', 'completed', 'Tool returned no output.'],
  ] as const;
  const view = await f.client.command('getChat', { target });
  for (const [entry, role, state, text] of expected) {
    const parts = await manifest(f.client, { kind: 'entry', target, entryId: String(entry.id) });
    assert.deepEqual(
      parts.map((part) => [part.partId, part.kind, part.role, part.state, part.text]),
      [['m0.empty', 'notice', role, state, text]],
    );
    assert.equal(view.entries.find((row) => row.id === String(entry.id))!.text, text);
  }
  const found = await f.client.command('findChatTranscript', { target, query: 'interrupted' });
  assert.deepEqual(
    found.matches.map((match) => [
      match.source.kind === 'entry' && match.source.entryId,
      match.partId,
    ]),
    [[String(aborted.id), 'm0.empty']],
  );
});

test('every live tool slot is read in the captured transaction and a missing result is a persistence fault', async (t) => {
  const held = makeHeldTools(t),
    getHarness = captureHarness(t),
    f = await fixture(t, held.registry),
    target = await f.create();
  f.faux.setResponses([
    fauxAssistantMessage(
      Array.from({ length: 10 }, (_, i) =>
        fauxToolCall(i ? 'quick' : 'hold', {}, { id: 'slot-' + i }),
      ),
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('All slots done'),
  ]);
  await f.client.command('sendChat', { target, requestId: 'send', text: 'Ten slots' });
  const parts = await until(
    async () => {
      const view = await f.client.command('getChat', { target });
      // Tools finish while this polls, so a source may change between capture and read.
      return view.run ? manifest(f.client, view.run.transcript!.source).catch(() => []) : [];
    },
    (parts) => parts.filter((part) => part.committed).length === 9,
  );
  const source = (await f.client.command('getChat', { target })).run!.transcript!.source;
  const last = parts.find((part) => part.partId.startsWith('tool9.'))!;
  assert(last.committed);
  const harness = getHarness(),
    commit = harness.commit.bind(harness);
  const captured: string[] = [],
    hidden = new Set<string>();
  t.mock.method(harness, 'commit', async (...args: Parameters<typeof commit>) => {
    const [change, ctx] = args;
    const reads: string[] = [];
    const result = await commit(
      (tx) =>
        change(
          new Proxy(tx, {
            get(object, key) {
              if (key === 'entry')
                return (...entryArgs: Parameters<typeof tx.entry>) => {
                  reads.push(String(entryArgs[0]));
                  return hidden.has(String(entryArgs[0])) ? undefined : object.entry(...entryArgs);
                };
              const value = Reflect.get(object, key);
              return typeof value === 'function' ? value.bind(object) : value;
            },
          }),
        ),
      ctx,
    );
    if (result && typeof result === 'object' && 'live' in result && 'boundary' in result)
      captured.push(...reads);
    return result;
  });
  assert.deepEqual(await manifest(f.client, source), parts);
  assert(captured.includes(last.committed!.entryId));
  hidden.add(last.committed!.entryId);
  await assert.rejects(manifest(f.client, source), { code: 'Persistence' });
  held.release();
});

test('records without messages carry the unsupported marker in manifests and Find skips it', async (t) => {
  const getHarness = captureHarness(t),
    f = await fixture(t),
    target = await f.create();
  const [unsupported, empty] = await getHarness().commit(
    async (tx) => [
      await tx.appendEntry(Number(target.conversationId) as ConversationId, {
        kind: 'app.unsupported-note',
        data: { note: 'Unsupported transcript record.' },
      }),
      await tx.appendEntry(Number(target.conversationId) as ConversationId, {
        kind: 'pi.user',
        model: [{ role: 'user', content: [], timestamp: 1 }],
      }),
    ],
    context,
  );
  const marker = await manifest(f.client, {
    kind: 'entry',
    target,
    entryId: String(unsupported.id),
  });
  assert.deepEqual(
    marker.map((part) => [part.partId, part.kind, part.availability, part.text]),
    [['marker', 'notice', 'unsupported', 'Unsupported transcript record.']],
  );
  assert.deepEqual(
    await manifest(f.client, { kind: 'entry', target, entryId: String(empty.id) }),
    [],
  );
  const view = await f.client.command('getChat', { target });
  assert.equal(
    view.entries.find((entry) => entry.id === String(unsupported.id))!.text,
    'Unsupported transcript record.',
  );
  const found = await f.client.command('findChatTranscript', { target, query: 'Unsupported' });
  assert.deepEqual(found.matches, []);
  assert.equal(found.nextCursor, null);
  assert.equal(found.progress.entries, 2);
});
