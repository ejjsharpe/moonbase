import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatTranscriptSource } from '@moonbase/contracts/chat';
import { groupBySource } from '../src/renderer/chat/stable-props.ts';

test('source groups match whatever the source key order', () => {
  const source = {
    kind: 'entry',
    target: { hostId: 'host', conversationId: 'chat' },
    entryId: 'e1',
  } as unknown as ChatTranscriptSource;
  const reordered = {
    entryId: 'e1',
    target: { conversationId: 'chat', hostId: 'host' },
    kind: 'entry',
  } as unknown as ChatTranscriptSource;
  const other = { ...source, entryId: 'e2' } as ChatTranscriptSource;
  const items = [
    { source, id: 1 },
    { source: reordered, id: 2 },
    { source: other, id: 3 },
  ];
  const groups = groupBySource(items);
  assert.deepEqual(
    groups(reordered).map((item) => item.id),
    [1, 2],
  );
  assert.deepEqual(
    groups(other).map((item) => item.id),
    [3],
  );
  assert.deepEqual(groups(undefined), []);
});
