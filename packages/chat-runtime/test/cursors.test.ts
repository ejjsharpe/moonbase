import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Effect } from 'effect';
import { Harness, type ConversationId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { ChatService, type ChatServiceShape } from '@moonbase/contracts/services';
import type { ChatTranscriptSource } from '@moonbase/contracts/chat';
import { fixture } from './runtime-fixture.ts';

type Read = 'manifest' | 'content' | 'around' | 'find';
const reads: Read[] = ['manifest', 'content', 'around', 'find'];
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const decode = (cursor: string) => JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
const refused = { _tag: 'InvalidChatRequestError', problem: 'transcript-cursor' };

/** A chat with a page past every transcript read's first, and a cursor from each. */
async function seed(t: TestContext) {
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
  const entries = await harness.commit(async (tx) => {
    const ids: string[] = [];
    for (let i = 0; i < 40; i++)
      ids.push(
        String(
          (
            await tx.appendEntry(Number(target.conversationId) as ConversationId, {
              kind: 'pi.user',
              model: [{ role: 'user', content: (i ? '' : '😀') + 'needle ' + i, timestamp: 1 }],
            })
          ).id,
        ),
      );
    const entry = await tx.appendEntry(Number(target.conversationId) as ConversationId, {
      kind: 'pi.assistant',
      model: [
        fauxAssistantMessage([
          ...Array.from({ length: 40 }, (_, i) => ({ type: 'text' as const, text: 'block ' + i })),
          // Two-byte characters across several content chunks.
          { type: 'text', text: 'α'.repeat(40000) },
        ]),
      ],
    });
    return [...ids, String(entry.id)];
  }, context);
  const source: ChatTranscriptSource = { kind: 'entry', target, entryId: entries.at(-1)! };
  const call = <A, E>(run: (chat: ChatServiceShape) => Effect.Effect<A, E>) =>
    f.runtime.runPromise(Effect.flatMap(ChatService, run));
  const first = await call((chat) => chat.getChatTranscriptContent({ source }));
  assert(first.kind === 'manifest');
  const manifestAll = await call((chat) =>
    chat.getChatTranscriptContent({ source, cursor: first.nextCursor! }),
  );
  assert(manifestAll.kind === 'manifest');
  const part = manifestAll.parts.at(-1)!;
  assert.equal(part.bytes, 80000);
  const selection = { partId: part.partId, bytes: part.bytes, revision: part.revision };
  const read = {
    manifest: (cursor?: string, change: object = {}) =>
      call((chat) => chat.getChatTranscriptContent({ source, cursor, ...change })),
    content: (cursor?: string, change: object = {}) =>
      call((chat) => chat.getChatTranscriptContent({ source, selection, cursor, ...change })),
    around: (cursor?: string, change: object = {}) =>
      call((chat) =>
        chat.getChatHistoryAround({ target, entryId: entries[20]!, cursor, ...change }),
      ),
    find: (cursor?: string, change: object = {}) =>
      call((chat) => chat.findChatTranscript({ target, query: 'needle', cursor, ...change })),
  };
  const content = await read.content();
  const around = await read.around();
  const find = await read.find();
  assert(content.kind === 'content');
  const cursors: Record<Read, string> = {
    manifest: first.nextCursor!,
    content: content.nextCursor!,
    around: around.olderCursor!,
    find: find.nextCursor!,
  };
  for (const kind of reads) assert(cursors[kind], kind);
  return { f, target, other, entries, source, selection, read, cursors };
}

test('malformed transcript cursors are refused by every read', async (t) => {
  const { f, read, cursors } = await seed(t);
  for (const kind of reads) {
    const cursor = cursors[kind];
    for (const malformed of [
      '!' + cursor,
      cursor + '=',
      cursor + 'A',
      // The signed format this replaced.
      cursor + '.' + 'A'.repeat(43),
      Buffer.from([0x7b, 0xff, 0x7d]).toString('base64url'),
      encode('not an object').slice(0, -2),
      Buffer.from('{"kind":').toString('base64url'),
      encode([decode(cursor)]),
      encode(null),
      'A'.repeat(1028),
      '\0',
    ])
      await assert.rejects(read[kind](malformed), refused, `${kind}: ${malformed.slice(0, 32)}`);
  }
  assert.equal(f.faux.state.callCount, 0);
});

test('transcript cursors outside their schema are refused', async (t) => {
  const { read, cursors } = await seed(t);
  for (const kind of reads) {
    const value = decode(cursors[kind]);
    for (const change of [
      { future: 'private-cursor-field-canary' },
      { kind: 'other' },
      { binding: 'A'.repeat(64) },
      { binding: undefined },
      { position: -1 },
      { position: 1.5 },
      { position: Number.MAX_SAFE_INTEGER + 2 },
      { position: '1' },
      { revision: 'not a digest' },
      { upper: '0' },
      { upper: 7 },
      { entries: -1 },
      { bytes: -1 },
      { part: { message: 0, block: 0 } },
      { part: { message: -1, block: 0, auxiliary: 0 } },
      { path: Array.from({ length: 33 }, () => 0) },
      { path: Array.from({ length: 30 }, () => Number.MAX_SAFE_INTEGER) },
      { offset: -1 },
      { textOffset: -1 },
      { direction: 'sideways' },
    ])
      await assert.rejects(
        read[kind](encode({ ...value, ...change })),
        refused,
        `${kind}: ${JSON.stringify(change).slice(0, 40)}`,
      );
  }
});

test('a transcript cursor opens only for the read and kind it continues', async (t) => {
  const { target, other, entries, selection, read, cursors } = await seed(t);
  // Every read refuses every other read's cursor.
  for (const kind of reads)
    for (const from of reads)
      if (from !== kind)
        await assert.rejects(read[kind](cursors[from]), refused, `${from} as ${kind}`);
  // A cursor whose kind alone is changed still belongs to its own read only.
  for (const kind of reads)
    for (const relabel of reads)
      if (relabel !== kind)
        await assert.rejects(
          read[kind](encode({ ...decode(cursors[kind]), kind: relabel })),
          refused,
          `${kind} relabelled ${relabel}`,
        );
  // The same kind of read, on another source, selection, entry, query or chat.
  const otherSource = { kind: 'entry', target, entryId: entries[0] };
  for (const [kind, change] of [
    ['manifest', { source: otherSource }],
    ['manifest', { source: { kind: 'entry', target: other, entryId: entries.at(-1) } }],
    ['content', { selection: { ...selection, bytes: selection.bytes - 2 } }],
    ['content', { source: otherSource }],
    ['around', { entryId: entries[21] }],
    ['find', { query: 'different' }],
    ['find', { target: other }],
  ] as const)
    await assert.rejects(read[kind](cursors[kind], change), refused, `${kind} for another read`);
});

test('a position forged inside a well-formed cursor fails in its read', async (t) => {
  const { read, cursors, selection, entries } = await seed(t);
  const manifest = decode(cursors.manifest);
  for (const change of [{ position: manifest.position + 1 }, { revision: 'a'.repeat(64) }])
    await assert.rejects(read.manifest(encode({ ...manifest, ...change })), {
      _tag: 'TranscriptChangedError',
      change: 'manifest',
    });
  const content = decode(cursors.content);
  await assert.rejects(read.content(encode({ ...content, position: selection.bytes + 2 })), {
    _tag: 'InvalidChatRequestError',
    problem: 'content-position',
  });
  // Odd offsets fall inside a two-byte character.
  await assert.rejects(read.content(encode({ ...content, position: content.position + 1 })), {
    _tag: 'InvalidChatRequestError',
    problem: 'content-split',
  });
  const around = decode(cursors.around);
  await assert.rejects(read.around(encode({ ...around, direction: undefined })), {
    _tag: 'InvalidChatRequestError',
    problem: 'history-direction',
  });
  const past = await read.around(encode({ ...around, position: Number(around.upper) + 1 }));
  assert.deepEqual(past.entries, []);
  const find = decode(cursors.find);
  const finished = await read.find(encode({ ...find, position: Number(find.upper) + 1 }));
  assert.deepEqual([finished.matches, finished.nextCursor], [[], null]);
  // Resuming inside the first entry's leading surrogate pair.
  const split = { position: Number(entries[0]), part: { message: 1, block: 0, auxiliary: 0 } };
  await assert.rejects(read.find(encode({ ...find, ...split, path: [], offset: 1 })), refused);
  // Counters past the cursor's bound could overflow the reply's safe integers.
  for (const counter of ['entries', 'bytes', 'textOffset'])
    await assert.rejects(
      read.find(encode({ ...find, [counter]: Number.MAX_SAFE_INTEGER })),
      refused,
      counter,
    );
  const counted = await read.find(encode({ ...find, entries: 2 ** 40, bytes: 2 ** 40 }));
  assert(counted.progress.entries > 2 ** 40 && Number.isSafeInteger(counted.progress.bytes));
});

test('cursors keep working across a restart', async (t) => {
  const { f, read, cursors } = await seed(t);
  const before = await Promise.all(reads.map((kind) => read[kind](cursors[kind])));
  await f.restart();
  assert.deepEqual(await Promise.all(reads.map((kind) => read[kind](cursors[kind]))), before);
});

test('list and history cursor envelopes reject unfamiliar fields without execution', async (t) => {
  const f = await fixture(t),
    canary = 'private-cursor-field-canary';
  const target = await f.create();
  for (const payload of [
    { kind: 'history', scan: null, future: canary },
    { kind: 'history', scan: { start: true, future: canary } },
    { kind: 'history', scan: [] },
    { kind: 'unknown', scan: null },
  ])
    await assert.rejects(f.client.command('getChatHistory', { target, cursor: encode(payload) }), {
      code: 'InvalidInput',
    });
  assert.equal(f.faux.state.callCount, 0);
});
