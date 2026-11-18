import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Harness, type ConversationId, type EntryRecord } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { ChatOutput } from '@moonbase/contracts/chat';
import { fixture, runChat } from '../runtime-fixture.ts';

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
    const page: ChatOutput<'findChatTranscript'> = await runChat(f.runtime, (chat) =>
      chat.findChatTranscript({
        target,
        query: 'absent',
        ...(cursor ? { cursor } : {}),
      }),
    );
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
      const page = await runChat(f.runtime, (chat) =>
        chat.findChatTranscript({
          target,
          query: 'needle',
          ...(cursor ? { cursor } : {}),
        }),
      );
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
