import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatEntry, ChatTranscript, ChatTranscriptPart } from '@moonbase/contracts/chat';
import {
  collectResultsByCall,
  getCallKey,
  getTranscriptParts,
  listShownTranscripts,
} from '../../../src/chat/transcript/results-by-call.ts';
const part = (
  id: string,
  kind: ChatTranscriptPart['kind'],
  extra: Partial<ChatTranscriptPart> = {},
): ChatTranscriptPart => ({
  partId: id,
  kind,
  role: 'assistant',
  text: '',
  encoding: 'utf8',
  bytes: 0,
  revision: 'a'.repeat(64),
  availability: 'available',
  truncated: false,
  ...extra,
});
const transcript = (entryId: string, parts: ChatTranscriptPart[]): ChatTranscript => ({
  source: {
    kind: 'entry',
    target: {
      host: { hostId: 'host', storeId: 'store' },
      actorId: 'actor',
      conversationId: 'chat',
    },
    entryId,
  },
  thinking: 'none',
  parts,
  nextCursor: null,
});
const liveTranscript = (parts: ChatTranscriptPart[]): ChatTranscript => ({
  ...transcript('', parts),
  source: {
    kind: 'live',
    target: transcript('', []).source.target,
    submissionId: 'submission',
    taskId: 'task',
    attempt: 0,
    incarnation: 'a'.repeat(64),
  },
});
test('stale exact live descriptions use current prefix content and selection while retaining recorded paged order', () => {
  const loaded = liveTranscript([
    part('z-answer', 'text', { text: 'Before' }),
    part('q-thought', 'thinking', { text: 'Thought first', bytes: 13 }),
    part('b-output', 'result', { text: 'Output first', bytes: 12, state: 'running' }),
    part('y-details', 'details'),
    part('a-paged-only', 'details', { text: 'Retained fifth part' }),
  ]);
  const current = liveTranscript([
    loaded.parts[0]!,
    { ...loaded.parts[1]!, text: 'Thought first and next', bytes: 22, revision: 'b'.repeat(64) },
    {
      ...loaded.parts[2]!,
      text: 'Output first and next',
      bytes: 21,
      revision: 'c'.repeat(64),
      state: 'failed',
    },
    loaded.parts[3]!,
  ]);
  const parts = getTranscriptParts(current, { ...loaded, status: 'source-changed' });
  assert.deepEqual(
    parts.map((part) => part.partId),
    ['z-answer', 'q-thought', 'b-output', 'y-details', 'a-paged-only'],
  );
  assert.equal(parts[1]?.text, 'Thought first and next');
  assert.equal(parts[1]?.bytes, 22);
  assert.equal(parts[1]?.revision, 'b'.repeat(64));
  assert.equal(parts[2]?.text, 'Output first and next');
  assert.equal(parts[2]?.bytes, 21);
  assert.equal(parts[2]?.revision, 'c'.repeat(64));
  assert.equal(parts[2]?.state, 'failed');
  assert.equal(parts[4], loaded.parts[4]);
});
test('current loaded pages stay authoritative until stale, and empty pages keep their preview', () => {
  const current = liveTranscript([part('part', 'thinking', { text: 'Observed' })]);
  const parts = [part('part', 'thinking', { text: 'Newly read' })];
  for (const status of ['partial', 'loading', 'complete', 'error'] as const)
    assert.equal(getTranscriptParts(current, { ...current, parts, status }), parts);
  assert.equal(
    getTranscriptParts(current, { ...current, parts: [], status: 'error' }),
    current.parts,
  );
  const durable = transcript('durable', current.parts);
  assert.equal(getTranscriptParts(durable, { ...durable, parts, status: 'source-changed' }), parts);
});
test('foreign targets, entries and live attempts cannot supply loaded descriptions', () => {
  const current = liveTranscript([part('part', 'thinking', { text: 'Current' })]);
  const source = current.source;
  assert.equal(source.kind, 'live');
  const target = source.target;
  for (const foreign of [
    { ...source, target: { ...target, host: { ...target.host, hostId: 'foreign' } } },
    { ...source, target: { ...target, host: { ...target.host, storeId: 'foreign' } } },
    { ...source, target: { ...target, actorId: 'foreign' } },
    { ...source, target: { ...target, conversationId: 'foreign' } },
    { ...source, submissionId: 'foreign' },
    { ...source, taskId: 'foreign' },
    { ...source, attempt: 1 },
    { ...source, incarnation: 'b'.repeat(64) },
    transcript('foreign', []).source,
  ]) {
    assert.equal(
      getTranscriptParts(current, {
        source: foreign,
        parts: [part('foreign', 'thinking', { text: 'Foreign' })],
        status: 'source-changed',
      }),
      current.parts,
    );
  }
});
test("a call's results come from the shown transcripts, a loaded manifest only for its own source", () => {
  const call = part('call', 'arguments', { state: 'requested' });
  const origin = transcript('origin', [call]);
  const result = transcript('result', [
    part('result', 'result', {
      role: 'tool',
      state: 'failed',
      pairing: 'matched',
      call: { entryId: 'origin', partId: 'call' },
    }),
  ]);
  const entries: ChatEntry[] = [
    { id: 'origin', role: 'assistant', text: '', truncated: false, transcript: origin },
    { id: 'result', role: 'tool', text: '', truncated: false, transcript: result },
  ];
  const stateOf = (
    manifest: { source: ChatTranscript['source']; parts: ChatTranscriptPart[] } | null,
  ) =>
    collectResultsByCall(
      listShownTranscripts({
        entries,
        rows: [],
        manifest: manifest && {
          ...manifest,
          nextCursor: null,
          omittedParts: 0,
          status: 'complete',
          error: null,
        },
      }),
    )
      .get(getCallKey(origin.source, 'origin', 'call'))
      ?.map((part) => part.state);
  // An empty manifest keeps the preview's results.
  assert.deepEqual(stateOf(null), ['failed']);
  assert.deepEqual(stateOf({ source: result.source, parts: [] }), ['failed']);
  const completed = [{ ...result.parts[0]!, state: 'completed' as const }];
  assert.deepEqual(stateOf({ source: result.source, parts: completed }), ['completed']);
  const foreign = structuredClone(result.source);
  foreign.target.host.storeId = 'other';
  for (const source of [transcript('other-entry', []).source, foreign])
    assert.deepEqual(stateOf({ source, parts: completed }), ['failed']);
  // An ambiguous pairing is no result.
  const ambiguous = transcript('ambiguous', [{ ...result.parts[0]!, pairing: 'ambiguous' }]);
  assert.equal(collectResultsByCall([ambiguous]).size, 0);
});
