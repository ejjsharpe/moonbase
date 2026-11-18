import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Atom from 'effect/reactivity/Atom';
import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import type { ChatTranscriptSource } from '@moonbase/contracts/chat';
import { makeTranscriptAtoms } from '../../../src/chat/transcript/transcript-atoms.ts';
import { getTranscriptSourceKey } from '../../../src/chat/transcript/transcript-row-state.ts';
import {
  makeEmptyTranscriptState,
  type TranscriptContentState,
  type TranscriptState,
} from '../../../src/chat/transcript/transcript-state.ts';

const target = {
  host: { hostId: 'host', storeId: 'store' },
  actorId: 'actor',
  conversationId: 'c',
};
const source = (entryId: string): ChatTranscriptSource => ({ kind: 'entry', target, entryId });
const content = (entryId: string, loadedBytes: number): TranscriptContentState => ({
  source: source(entryId),
  selection: { partId: 'p', bytes: 8, revision: 'a'.repeat(64) },
  chunks: [],
  loadedBytes,
  loadedText: loadedBytes,
  retainedFrom: 0,
  nextCursor: null,
  status: 'partial',
  error: null,
});

test("a row's atom notifies only when its own source's state changes", () => {
  const registry = AtomRegistry.make();
  const transcript = Atom.make<TranscriptState>({
    ...makeEmptyTranscriptState(),
    content: [content('a', 1), content('b', 1)],
  });
  const atoms = makeTranscriptAtoms(transcript);
  // Keys are the same whatever a source's key order.
  const keyA = getTranscriptSourceKey({ entryId: 'a', target, kind: 'entry' });
  let notified = 0;
  const release = registry.subscribe(atoms.row(keyA), () => notified++, { immediate: true });
  const first = registry.get(atoms.row(keyA));
  assert.equal(first.contents.length, 1);
  const update = (change: (state: TranscriptState) => Partial<TranscriptState>) =>
    registry.update(transcript, (state) => ({ ...state, ...change(state) }));
  // Another row's content and a fresh, equal view publish nothing to this row.
  update((state) => ({ content: [state.content[0]!, content('b', 2)] }));
  update((state) => ({
    view: { anchor: { key: 'entry:b', offset: 3 }, expanded: [...state.view.expanded] },
  }));
  assert.equal(notified, 1);
  assert.equal(registry.get(atoms.row(keyA)), first);
  // Its own content, an expansion and a Find match in it each do.
  update((state) => ({ content: [content('a', 2), state.content[1]!] }));
  update((state) => ({ view: { ...state.view, expanded: ['x'] } }));
  update((state) => ({
    find: {
      ...state.find,
      query: 'needle',
      active: {
        source: source('a') as never,
        partId: 'p',
        start: 0,
        end: 6,
        snippet: { text: 'needle', start: 0 },
      } as never,
    },
  }));
  assert.equal(notified, 4);
  const found = registry.get(atoms.row(keyA));
  assert.equal(found.findQuery, 'needle');
  assert.equal(found.findMatch?.partId, 'p');
  assert.equal(registry.get(atoms.row(getTranscriptSourceKey(source('b')))).findMatch, null);
  release();
});
