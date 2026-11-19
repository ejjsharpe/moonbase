import assert from 'node:assert/strict';
import { type ErrorGroup, getErrorGroup } from '@moonbase/contracts/error-groups';
import { test } from 'node:test';
import { Effect } from 'effect';
import { Harness, type ConversationId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { ChatTarget, ChatOutput } from '@moonbase/contracts/chat';
import { fixture, runChat, type ChatRuntime } from '../runtime-fixture.ts';
/** Whether a failure means `group` for its request. */
const inGroup = (group: ErrorGroup) => (error: unknown) => getErrorGroup(error) === group;

async function collect(runtime: ChatRuntime, target: ChatTarget, query: string, cursor?: string) {
  const matches: ChatOutput<'findChatTranscript'>['matches'] = [];
  const pages: ChatOutput<'findChatTranscript'>[] = [];
  do {
    const page = await runChat(runtime, (chat) =>
      chat.findChatTranscript({
        target,
        query,
        ...(cursor ? { cursor } : {}),
      }),
    );
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
    const result = await collect(f.runtime, target, query as string);
    const found = result.matches.filter((match) => match.partId === 'm0.b2');
    assert.deepEqual(
      found.map((match) => text.slice(match.start, match.end)),
      expected,
    );
    assert(result.pages.some((page) => page.matches.length === 0 && page.nextCursor !== null));
  }
  const needle = await collect(f.runtime, target, 'needle');
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
    (await collect(f.runtime, target, 'needle', needle.pages[0].startCursor)).matches,
    needle.matches,
  );
  assert.equal(
    (await collect(f.runtime, target, 'needle')).matches.length,
    needle.matches.length + 1,
  );
  for (const query of ['PRIVATE', 'REDACTED', 'IMAGESECRET'])
    assert.deepEqual((await collect(f.runtime, target, query)).matches, []);
  await assert.rejects(
    runChat(f.runtime, (chat) =>
      chat.findChatTranscript({
        target: { ...target, actorId: 'foreign' },
        query: 'needle',
        cursor: needle.pages[0].startCursor,
      }),
    ),
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
  assert.equal((await collect(f.runtime, target, ' ')).pages[0].nextCursor, null);
  await harness.commit(
    (tx) =>
      tx.appendEntry(Number(target.conversationId) as ConversationId, {
        kind: 'pi.user',
        model: [{ role: 'user', content: 'a'.repeat(2000), timestamp: 1 }],
      }),
    context,
  );
  const found = await collect(f.runtime, target, 'a');
  assert.equal(found.matches.length, 2000);
  assert.deepEqual(
    found.matches.map((match) => match.start),
    Array.from({ length: 2000 }, (_, i) => i),
  );
});

test('Find cancellation interrupts the read, leaves exact Stop and unrelated reads responsive, and shutdown owns actual SDK settlement', async (t) => {
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
  await runChat(f.runtime, (chat) => chat.sendChat({ target, requestId: 'run', text: 'Running' }));
  const { until } = await import('../runtime-fixture.ts');
  const view = await until(
    () => runChat(f.runtime, (chat) => chat.getChat({ target })),
    (view) => !!view.run,
  );
  let release!: () => void,
    held = false,
    closed = false,
    // Scans of the chat Find makes after the one it was cancelled during.
    scansAfterCancel = 0;
  const gate = new Promise<void>((resolve) => (release = resolve));
  t.after(() => release());
  const commit = harness.commit.bind(harness),
    close = harness.close.bind(harness);
  t.mock.method(harness, 'commit', async (...args: Parameters<typeof commit>) => {
    const value = await commit(...args);
    if (
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
      if (held) scansAfterCancel++;
      else {
        held = true;
        await gate;
      }
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
  const rejected = assert.rejects(pending, inGroup('cancelled'));
  await until(async () => held, Boolean);
  abort.abort();
  await rejected;
  assert.equal((await runChat(f.runtime, (chat) => chat.getChat({ target: other }))).state, 'idle');
  assert(
    ['pending', 'terminal', 'stopped'].includes(
      (
        await runChat(f.runtime, (chat) =>
          chat.stopChat({ stop: view.run!.stop, requestId: 'stop' }),
        )
      ).outcome,
    ),
  );
  // Disposal interrupts the runtime's own calls before it closes the host, so one held open
  // settles as shutdown begins.
  const caller = runChat(f.runtime, () => Effect.never).catch(() => undefined);
  let disposed = false;
  const disposal = f.dispose().then(() => (disposed = true));
  await caller;
  assert.equal(disposed, false);
  assert.equal(closed, false);
  release();
  releaseProvider();
  await disposal;
  assert(closed);
  assert.equal(scansAfterCancel, 0);
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
    const result = await collect(f.runtime, target, query);
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
  const { localPiRuntime } = await import('../runtime-fixture.ts');
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
    localPiRuntime({
      ...session,
      models: f.config.models,
      databasePath: f.config.databasePath + '-bounded',
    }),
  );
  try {
    const target = (
      await runChat(runtime, (chat) =>
        chat.createChat({
          session,
          requestId: 'dense',
          title: 'Dense escaped source',
          settings: f.settings,
        }),
      )
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
    const result = await collect(runtime, target, query);
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
  const result = await collect(f.runtime, target, 'deepneedle');
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
      const page: ChatOutput<'findChatTranscript'> = await runChat(f.runtime, (chat) =>
        chat.findChatTranscript({
          target,
          query,
          ...(cursor ? { cursor } : {}),
        }),
      );
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
