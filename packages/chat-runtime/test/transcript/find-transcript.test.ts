import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Harness, type ConversationId, type EntryRecord } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { ChatClient, ChatTarget, ChatOutput } from '@moonbase/contracts/chat';
import { fixture } from '../runtime-fixture.ts';

async function collect(client: ChatClient, target: ChatTarget, query: string, cursor?: string) {
  const matches: ChatOutput<'findChatTranscript'>['matches'] = [];
  const pages: ChatOutput<'findChatTranscript'>[] = [];
  do {
    const page = await client.command('findChatTranscript', {
      target,
      query,
      ...(cursor ? { cursor } : {}),
    });
    assert.equal(page.query, query);
    assert.deepEqual(page.target, target);
    assert.equal(page.cursor, cursor ?? null);
    assert(Buffer.byteLength(JSON.stringify({ ok: true, value: page })) < 256 * 1024);
    assert(page.matches.length <= 32);
    if (pages.length) assert.equal(page.upperEntryId, pages[0].upperEntryId);
    pages.push(page);
    matches.push(...page.matches);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return { matches, pages };
}

test('Find scans 1,100 mixed saved records and lazy long JSON with exact Unicode ranges, fixed cutoff and replay', async (t) => {
  let harness!: Harness;
  const open = Harness.open;
  t.mock.method(
    Harness,
    'open',
    async (...args: Parameters<typeof open>) => (harness = await open(...args)),
  );
  const f = await fixture(t),
    target = await f.create();
  const text = 'x'.repeat(16382) + '😀Σςσ Kk 𐐀𐐨 İi\r\n[.*] ' + 'x'.repeat(70000) + ' END';
  const json = { prefix: 'a'.repeat(300000), nested: [text, { patch: 'recorded NEEDLE patch' }] };
  const entry = await harness.commit(async (tx) => {
    for (let i = 0; i < 1100; i++)
      await tx.appendEntry(
        Number(target.conversationId) as ConversationId,
        i % 2
          ? { kind: 'pi.reset', head: 'self' }
          : { kind: 'pi.user', model: [{ role: 'user', content: 'saved ' + i, timestamp: 1 }] },
      );
    return tx.appendEntry(Number(target.conversationId) as ConversationId, {
      kind: 'pi.assistant',
      model: [
        fauxAssistantMessage([
          { type: 'thinking', thinking: 'thinking NEEDLE', thinkingSignature: 'PRIVATE' },
          { type: 'thinking', thinking: 'REDACTED', redacted: true },
          { type: 'text', text },
          fauxToolCall('edit', json),
        ]),
        {
          role: 'toolResult',
          toolCallId: 'call',
          toolName: 'edit',
          isError: false,
          timestamp: 1,
          content: [
            { type: 'text', text: 'output NEEDLE' },
            {
              type: 'image',
              data: Buffer.from('IMAGESECRET').toString('base64'),
              mimeType: 'image/png',
            },
          ],
          details: { patch: 'recorded NEEDLE patch', diff: 'NEEDLE diff' },
        },
      ],
    });
  }, context);
  for (const [query, expected] of [
    ['σ', ['Σ', 'ς', 'σ']],
    ['k', ['K', 'k']],
    ['𐐨', ['𐐀', '𐐨']],
    ['😀', ['😀']],
    ['i', ['i']],
    ['\r\n', ['\r\n']],
    ['[.*]', ['[.*]']],
  ]) {
    const result = await collect(f.client, target, query as string);
    const found = result.matches.filter((match) => match.partId === 'm0.b2');
    assert.deepEqual(
      found.map((match) => text.slice(match.start, match.end)),
      expected,
    );
    assert(result.pages.some((page) => page.matches.length === 0 && page.nextCursor !== null));
  }
  const needle = await collect(f.client, target, 'needle');
  assert(needle.matches.some((match) => match.partId === 'm0.b0'));
  const args = JSON.stringify(json);
  assert(
    needle.matches.some(
      (match) => match.partId === 'm0.b3' && args.slice(match.start, match.end) === 'NEEDLE',
    ),
  );
  assert(needle.matches.some((match) => match.partId === 'm1.patch'));
  assert.equal(needle.pages[0].upperEntryId, String(entry.id));
  await harness.commit(
    (tx) =>
      tx.appendEntry(Number(target.conversationId) as ConversationId, {
        kind: 'pi.user',
        model: [{ role: 'user', content: 'NEEDLE appended', timestamp: 1 }],
      }),
    context,
  );
  assert.deepEqual(
    (await collect(f.client, target, 'needle', needle.pages[0].startCursor)).matches,
    needle.matches,
  );
  assert.equal(
    (await collect(f.client, target, 'needle')).matches.length,
    needle.matches.length + 1,
  );
  for (const query of ['PRIVATE', 'REDACTED', 'IMAGESECRET'])
    assert.deepEqual((await collect(f.client, target, query)).matches, []);
  await assert.rejects(
    f.client.command('findChatTranscript', {
      target: { ...target, actorId: 'foreign' },
      query: 'needle',
      cursor: needle.pages[0].startCursor,
    }),
  );
});

test('Find dense pages advance within a part and empty saved conversations complete', async (t) => {
  let harness!: Harness;
  const open = Harness.open;
  t.mock.method(
    Harness,
    'open',
    async (...args: Parameters<typeof open>) => (harness = await open(...args)),
  );
  const f = await fixture(t),
    target = await f.create();
  assert.equal((await collect(f.client, target, ' ')).pages[0].nextCursor, null);
  await harness.commit(
    (tx) =>
      tx.appendEntry(Number(target.conversationId) as ConversationId, {
        kind: 'pi.user',
        model: [{ role: 'user', content: 'a'.repeat(2000), timestamp: 1 }],
      }),
    context,
  );
  const found = await collect(f.client, target, 'a');
  assert.equal(found.matches.length, 2000);
  assert.deepEqual(
    found.matches.map((match) => match.start),
    Array.from({ length: 2000 }, (_, i) => i),
  );
});

test('Find cancellation leaves exact Stop and unrelated reads responsive while shutdown owns actual SDK settlement', async (t) => {
  let harness!: Harness;
  const open = Harness.open;
  t.mock.method(
    Harness,
    'open',
    async (...args: Parameters<typeof open>) => (harness = await open(...args)),
  );
  const f = await fixture(t),
    target = await f.create(),
    other = await f.create('other');
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>((resolve) => (releaseProvider = resolve));
  t.after(() => releaseProvider());
  f.faux.setResponses([
    async () => {
      await providerGate;
      return fauxAssistantMessage('Completed');
    },
  ]);
  await f.client.command('sendChat', { target, requestId: 'run', text: 'Running' });
  const { until } = await import('../runtime-fixture.ts');
  const view = await until(
    () => f.client.command('getChat', { target }),
    (view) => !!view.run,
  );
  let release!: () => void,
    held = false,
    closed = false;
  const gate = new Promise<void>((resolve) => (release = resolve));
  t.after(() => release());
  const commit = harness.commit.bind(harness),
    close = harness.close.bind(harness);
  t.mock.method(harness, 'commit', async (...args: Parameters<typeof commit>) => {
    const value = await commit(...args);
    if (
      !held &&
      value &&
      typeof value === 'object' &&
      'items' in value &&
      Array.isArray(value.items) &&
      value.items.some(
        (item: unknown) =>
          !!item &&
          typeof item === 'object' &&
          'conversationId' in item &&
          item.conversationId === Number(target.conversationId),
      )
    ) {
      held = true;
      await gate;
    }
    return value;
  });
  t.mock.method(harness, 'close', async (...args: Parameters<typeof close>) => {
    closed = true;
    return close(...args);
  });
  const abort = new AbortController();
  const pending = f.client.command(
    'findChatTranscript',
    { target, query: 'Running' },
    { signal: abort.signal },
  );
  const rejected = assert.rejects(pending, { code: 'Cancelled' });
  await until(async () => held, Boolean);
  abort.abort();
  await rejected;
  assert.equal((await f.client.command('getChat', { target: other })).state, 'idle');
  assert(
    ['pending', 'terminal', 'stopped'].includes(
      (await f.client.command('stopChat', { stop: view.run!.stop, requestId: 'stop' })).outcome,
    ),
  );
  let disposed = false;
  const disposal = f.dispose().then(() => (disposed = true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(disposed, false);
  assert.equal(closed, false);
  release();
  releaseProvider();
  await disposal;
  assert(closed);
});

test('Find JSON token continuations preserve string escaping, long keys, nesting and split Unicode', async (t) => {
  let harness!: Harness;
  const open = Harness.open;
  t.mock.method(
    Harness,
    'open',
    async (...args: Parameters<typeof open>) => (harness = await open(...args)),
  );
  const f = await fixture(t),
    target = await f.create();
  const key = 'a'.repeat(50000) + 'KEYNEEDLE';
  const json = {
    [key]: [
      'x'.repeat(4095) + '😀\\"\nNEEDLE' + 'x'.repeat(20000),
      { deeper: ['JSONNEEDLE', null, true, 17] },
    ],
    other: 'ENDNEEDLE',
  };
  const text = JSON.stringify(json);
  await harness.commit(
    (tx) =>
      tx.appendEntry(Number(target.conversationId) as ConversationId, {
        kind: 'pi.assistant',
        model: [fauxAssistantMessage([fauxToolCall('edit', json)])],
      }),
    context,
  );
  for (const query of ['needle', '\\nNEEDLE', '😀', '":["', 'null,true,17', 'KEYNEEDLE']) {
    const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
    const expected = [...text.matchAll(expression)].map((match) => [
      match.index,
      match.index + match[0].length,
    ]);
    const result = await collect(f.client, target, query);
    assert.deepEqual(
      result.matches.map((match) => [match.start, match.end]),
      expected,
    );
    for (const match of result.matches)
      assert.equal(
        match.snippet.text,
        text.slice(match.snippet.start, match.snippet.start + match.snippet.text.length),
      );
  }
});

test('Find adapts dense escaped matches to actual JSON envelopes with maximum-size authorities', async (t) => {
  const { ManagedRuntime } = await import('effect');
  const { LocalPiRuntimeLive } = await import('../../src/index.ts');
  const { makeChatClient } = await import('@moonbase/application/runtime/clients');
  let harness!: Harness;
  const open = Harness.open;
  t.mock.method(
    Harness,
    'open',
    async (...args: Parameters<typeof open>) => (harness = await open(...args)),
  );
  const f = await fixture(t);
  const session = {
    host: { hostId: 'h'.repeat(256), storeId: 's'.repeat(256) },
    actorId: 'a'.repeat(256),
  };
  const runtime = ManagedRuntime.make(
    LocalPiRuntimeLive({
      ...session,
      models: f.config.models,
      databasePath: f.config.databasePath + '-bounded',
    }),
  );
  try {
    const client = makeChatClient(runtime);
    const target = (
      await client.command('createChat', {
        session,
        requestId: 'dense',
        title: 'Dense escaped source',
        settings: f.settings,
      })
    ).conversation.target;
    const query = '\u0001'.repeat(1024),
      text = query.repeat(40);
    await harness.commit(
      (tx) =>
        tx.appendEntry(Number(target.conversationId) as ConversationId, {
          kind: 'pi.user',
          model: [{ role: 'user', content: text, timestamp: 1 }],
        }),
      context,
    );
    const result = await collect(client, target, query);
    assert.equal(result.matches.length, 40);
    assert(result.pages[0].matches.length < 32);
    let bytes = 0,
      entries = 0;
    for (const page of result.pages) {
      assert(page.progress.bytes - bytes <= 256 * 1024);
      assert(page.progress.entries - entries <= 32);
      bytes = page.progress.bytes;
      entries = page.progress.entries;
    }
    assert.deepEqual(
      result.matches.map((match) => match.start),
      Array.from({ length: 40 }, (_, i) => i * 1024),
    );
  } finally {
    await runtime.dispose();
  }
});

test('Find continuations inside deeply nested JSON with wide indexes always fit the cursor limit', async (t) => {
  let harness!: Harness;
  const open = Harness.open;
  t.mock.method(
    Harness,
    'open',
    async (...args: Parameters<typeof open>) => (harness = await open(...args)),
  );
  const f = await fixture(t),
    target = await f.create();
  let deep: (string | number | unknown[])[] = Array.from(
    { length: 80 },
    (_, i) => 'DEEPNEEDLE ' + i,
  );
  for (let level = 0; level < 100; level++) deep = [...Array<number>(999).fill(0), deep];
  const json = { deep } as Parameters<typeof fauxToolCall>[1];
  const text = JSON.stringify(json);
  await harness.commit(
    (tx) =>
      tx.appendEntry(Number(target.conversationId) as ConversationId, {
        kind: 'pi.assistant',
        model: [fauxAssistantMessage([fauxToolCall('edit', json)])],
      }),
    context,
  );
  const result = await collect(f.client, target, 'deepneedle');
  assert(result.pages.length > 2);
  for (const page of result.pages) assert((page.nextCursor ?? '').length <= 1024);
  assert.deepEqual(
    result.matches.map((match) => [match.start, match.end]),
    [...text.matchAll(/deepneedle/giu)].map((match) => [match.index, match.index + 10]),
  );
  for (const match of result.matches)
    assert.equal(
      match.snippet.text,
      text.slice(match.snippet.start, match.snippet.start + match.snippet.text.length),
    );
});

test('a continuation does not enumerate more than the declared 32-part work bound', async (t) => {
  let harness!: Harness;
  const open = Harness.open;
  t.mock.method(
    Harness,
    'open',
    async (...args: Parameters<typeof open>) => (harness = await open(...args)),
  );
  const f = await fixture(t),
    target = await f.create();
  await harness.commit(
    (tx) =>
      tx.appendEntry(Number(target.conversationId) as ConversationId, {
        kind: 'pi.user',
        model: [
          {
            role: 'user',
            timestamp: 1,
            content: Array.from({ length: 1024 }, () => ({ type: 'text', text: 'ordinary' })),
          },
        ],
      }),
    context,
  );
  let visits = 0,
    indexedVisits = 0;
  const commit = harness.commit.bind(harness);
  t.mock.method(harness, 'commit', async (...args: Parameters<typeof commit>) => {
    const value = await commit(...args);
    if (value && typeof value === 'object' && 'items' in value && Array.isArray(value.items))
      for (const item of value.items as EntryRecord[]) {
        const content = item.model?.[0]?.content;
        if (Array.isArray(content))
          for (let i = 0; i < content.length; i++) {
            const block = content[i];
            Object.defineProperty(content, i, {
              configurable: true,
              get() {
                indexedVisits++;
                return block;
              },
            });
          }
        if (Array.isArray(content))
          Object.defineProperty(content, 'entries', {
            configurable: true,
            value: function* (): ArrayIterator<[number, (typeof content)[number]]> {
              for (let i = 0; i < content.length; i++) {
                visits++;
                yield [i, content[i]];
              }
              return undefined;
            },
          });
      }
    return value;
  });
  let cursor: string | null | undefined;
  const counts = [],
    indexedCounts = [];
  do {
    visits = 0;
    indexedVisits = 0;
    const page: ChatOutput<'findChatTranscript'> = await f.client.command('findChatTranscript', {
      target,
      query: 'absent',
      ...(cursor ? { cursor } : {}),
    });
    counts.push(visits);
    indexedCounts.push(indexedVisits);
    cursor = page.nextCursor;
  } while (cursor);
  console.log('part visits per bounded slice:', counts);
  // One lookahead may advance the iterator once beyond the 32 processed parts.
  assert(Math.max(...counts) <= 33);
  console.log('indexed block reads per bounded slice:', indexedCounts);
  assert(Math.max(...indexedCounts) <= 33);
  assert(indexedCounts.some((count) => count > 0));
});

test('lazy JSON matches JSON.stringify across escaped controls and lone/pair surrogate boundaries', async (t) => {
  let harness!: Harness;
  const open = Harness.open;
  t.mock.method(
    Harness,
    'open',
    async (...args: Parameters<typeof open>) => (harness = await open(...args)),
  );
  const f = await fixture(t),
    target = await f.create();
  const json = {
    ['k'.repeat(4095) + '😀\udc00' + '\\"']: [
      'x'.repeat(4094) + '\ud800a\udc00😀\u0000\b\f\r\n\t' + 'y'.repeat(16400),
      { str: '\\uD800 punctuation },[ : true', arr: [null, true, false, -0, 1e22] },
    ],
  };
  const text = JSON.stringify(json);
  await harness.commit(
    (tx) =>
      tx.appendEntry(Number(target.conversationId) as ConversationId, {
        kind: 'pi.user',
        model: [
          {
            role: 'toolResult',
            toolCallId: 'call',
            toolName: 'custom',
            timestamp: 1,
            isError: false,
            content: [],
            details: json,
          },
        ],
      }),
    context,
  );
  for (const query of [
    '😀',
    '\\ud800',
    '\\udc00',
    '\\u0000',
    '\\r\\n',
    '},{',
    'true',
    '0',
    'k😀',
  ]) {
    let cursor: string | null | undefined;
    const found: ChatOutput<'findChatTranscript'>['matches'] = [];
    do {
      const page: ChatOutput<'findChatTranscript'> = await f.client.command('findChatTranscript', {
        target,
        query,
        ...(cursor ? { cursor } : {}),
      });
      found.push(...page.matches.filter((m) => m.partId === 'm0.details'));
      cursor = page.nextCursor;
    } while (cursor);
    const expr = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
    assert.deepEqual(
      found.map((m) => [m.start, m.end]),
      [...text.matchAll(expr)].map((m) => [m.index, m.index + m[0].length]),
      query,
    );
    for (const m of found)
      assert.equal(
        m.snippet.text,
        text.slice(m.snippet.start, m.snippet.start + m.snippet.text.length),
      );
  }
});

test('direct message and auxiliary positions bound empty-message work and preserve every matching part on replay', async (t) => {
  let harness!: Harness;
  const open = Harness.open;
  t.mock.method(
    Harness,
    'open',
    async (...args: Parameters<typeof open>) => (harness = await open(...args)),
  );
  const f = await fixture(t),
    target = await f.create();
  const nestedCalls = {
    calls: [
      { id: 'nested', name: 'custom', arguments: { value: 'needle' }, status: 'ok' as const },
    ],
    complete: true,
  };
  const details = { patch: 'needle patch', diff: 'needle diff' };
  const entry = await harness.commit(
    (tx) =>
      tx.appendEntry(Number(target.conversationId) as ConversationId, {
        kind: 'pi.assistant',
        model: [
          ...Array.from({ length: 128 }, () => ({
            role: 'user' as const,
            timestamp: 1,
            content: [],
          })),
          fauxAssistantMessage([
            ...Array.from({ length: 31 }, () => ({ type: 'text' as const, text: 'needle text' })),
            { ...fauxToolCall('custom', { value: 'needle' }), argumentsError: 'needle error' },
          ]),
          {
            role: 'toolResult',
            toolCallId: 'call',
            toolName: 'custom',
            timestamp: 1,
            isError: false,
            content: Array.from({ length: 31 }, () => ({
              type: 'text' as const,
              text: 'needle output',
            })),
            nestedCalls,
            details,
          },
          { ...fauxAssistantMessage('needle final'), stopReason: 'error' },
        ],
      }),
    context,
  );
  const texts = new Map([
    ...Array.from({ length: 31 }, (_, b) => [`m128.b${b}`, 'needle text'] as const),
    ['m128.b31', JSON.stringify({ value: 'needle' })],
    ['m128.b31.arguments-error', 'needle error'],
    ...Array.from({ length: 31 }, (_, b) => [`m129.b${b}`, 'needle output'] as const),
    ['m129.nested-calls', JSON.stringify(nestedCalls)],
    ['m129.details', JSON.stringify(details)],
    ['m129.patch', details.patch],
    ['m129.diff', details.diff],
    ['m130.b0', 'needle final'],
  ]);
  let visits = 0;
  const commit = harness.commit.bind(harness);
  t.mock.method(harness, 'commit', async (...args: Parameters<typeof commit>) => {
    const value = await commit(...args);
    if (value && typeof value === 'object' && 'items' in value && Array.isArray(value.items))
      for (const item of value.items as EntryRecord[]) {
        const model = item.model;
        if (model)
          for (let m = 0; m < model.length; m++) {
            const message = model[m];
            Object.defineProperty(model, m, {
              configurable: true,
              get() {
                visits++;
                return message;
              },
            });
          }
      }
    return value;
  });
  async function collect(cursor?: string) {
    const pages: ChatOutput<'findChatTranscript'>[] = [];
    do {
      visits = 0;
      const page = await f.client.command('findChatTranscript', {
        target,
        query: 'needle',
        ...(cursor ? { cursor } : {}),
      });
      assert(visits <= 33, `message reads: ${visits}`);
      pages.push(page);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return pages;
  }
  const pages = await collect();
  assert(pages.filter((page) => !page.matches.length && page.nextCursor).length >= 4);
  const matches = pages.flatMap((page) => page.matches);
  assert.deepEqual(
    matches.map((match) => [match.partId, match.start, match.end]),
    [...texts].flatMap(([id, text]) =>
      [...text.matchAll(/needle/giu)].map((match) => [
        id,
        match.index,
        match.index + match[0].length,
      ]),
    ),
  );
  for (const match of matches) {
    assert.deepEqual(match.source, { kind: 'entry', target, entryId: String(entry.id) });
    const text = texts.get(match.partId)!;
    assert.equal(
      match.snippet.text,
      text.slice(match.snippet.start, match.snippet.start + match.snippet.text.length),
    );
  }
  assert.deepEqual(
    (await collect(pages[0].startCursor)).flatMap((page) => page.matches),
    matches,
  );
});
