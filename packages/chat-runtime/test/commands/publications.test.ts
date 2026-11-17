import type { CommitPublication, ConversationId } from '@earendil-works/pi-durable';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveDoc, NestedCallDoc } from '@earendil-works/pi-durable';
import { classifyPublication } from '../../src/commands/publications.ts';
import { Metadata, Store } from '../../src/documents.ts';

const watched = 1 as ConversationId,
  foreign = 2 as ConversationId;
const publication = (...changes: unknown[]) =>
  ({ seq: 1, changes }) as unknown as CommitPublication;
const document = (
  kind: string,
  conversationId: ConversationId | undefined,
  ops: unknown[],
  value: object | null = {},
  scope = 'conversation',
) => ({ type: 'document', record: { kind, scope: { kind: scope } }, conversationId, value, ops });
const live = (ops: unknown[], value: object | null = {}) =>
  document(LiveDoc.definition.kind, watched, ops, value);
const quiet = {
  relevant: false,
  invalidatesCapture: false,
  resetsHistory: false,
  resetsStatus: false,
  liveRetired: undefined,
};

test('publication classifier keeps streamed progress from invalidating a capture', () => {
  const progress = live([
    ['s', ['generation', 'message'], 'partial'],
    ['a', ['tools', 0, 'output'], 'line'],
    ['s', ['nestedTools', 1, 'droppedBytes'], 3],
  ]);
  assert.deepEqual(classifyPublication(publication(progress), watched), {
    ...quiet,
    relevant: true,
    liveRetired: false,
  });
  for (const ops of [
    [['s', ['run'], {}]],
    [['s', ['tools', 'name', 'output'], 'x']],
    [['s', ['tools', 0, 'state'], 'done']],
    [['r', {}]],
  ])
    assert.deepEqual(classifyPublication(publication(live(ops)), watched), {
      ...quiet,
      relevant: true,
      invalidatesCapture: true,
      liveRetired: false,
    });
});

test('publication classifier resets caches when a watched document is created, copied or retired', () => {
  const resets = {
    relevant: true,
    invalidatesCapture: true,
    resetsHistory: true,
    resetsStatus: true,
  };
  assert.deepEqual(classifyPublication(publication(live([], null)), watched), {
    ...resets,
    liveRetired: true,
  });
  // A replacement in the same commit leaves the live document present.
  assert.deepEqual(
    classifyPublication(publication(live([], null), live([['s', ['run'], {}]])), watched),
    { ...resets, liveRetired: false },
  );
  assert.deepEqual(
    classifyPublication(publication(document(Metadata.definition.kind, watched, [])), watched),
    { ...resets, liveRetired: undefined },
  );
  assert.deepEqual(
    classifyPublication(
      publication({
        type: 'document.copy',
        record: { kind: NestedCallDoc.definition.kind, scope: { kind: 'conversation' } },
        conversationId: watched,
        source: {},
      }),
      watched,
    ),
    { ...resets, liveRetired: undefined },
  );
  assert.deepEqual(
    classifyPublication(
      publication(
        document(Store.definition.kind, undefined, [['s', ['identity'], 'x']], {}, 'session'),
      ),
      watched,
    ),
    { ...resets, liveRetired: undefined },
  );
});

test('publication classifier scopes table changes and ignores unrelated documents', () => {
  const table = (type: string) =>
    type === 'conversation'
      ? { type, value: { id: watched } }
      : { type, value: { conversationId: watched } };
  const changed = { ...quiet, relevant: true, invalidatesCapture: true };
  assert.deepEqual(classifyPublication(publication(table('entry')), watched), {
    ...changed,
    resetsHistory: true,
  });
  assert.deepEqual(classifyPublication(publication(table('task')), watched), {
    ...changed,
    resetsStatus: true,
  });
  assert.deepEqual(classifyPublication(publication(table('conversation')), watched), {
    ...changed,
    resetsHistory: true,
    resetsStatus: true,
  });
  assert.deepEqual(classifyPublication(publication(table('submission')), watched), changed);
  assert.deepEqual(
    classifyPublication(
      publication(
        { type: 'entry', value: { conversationId: foreign } },
        { type: 'conversation', value: { id: foreign } },
        document(LiveDoc.definition.kind, foreign, [], null),
        document('another.kind', watched, []),
        document(Store.definition.kind, undefined, [], {}, 'conversation'),
      ),
      watched,
    ),
    quiet,
  );
  assert.deepEqual(classifyPublication(publication(), watched), quiet);
});
