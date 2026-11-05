import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatEntry, ChatTranscript, ChatTranscriptPart } from '@moonbase/contracts/chat';
import {
  collectActivityEvidence,
  getActivityState,
  getEntryTranscripts,
  getToolSummary,
  groupTranscriptParts,
} from '../src/renderer/chat/activity.ts';
import { parseRecordedPatch } from '../src/renderer/chat/recorded-patch.ts';
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
test('consecutive activity leaves every authored answer at its recorded position', () => {
  const parts = [
    part('before', 'text'),
    part('thought', 'thinking'),
    part('call', 'arguments'),
    part('between', 'text'),
    part('result', 'result', { role: 'tool' }),
    part('after', 'text'),
  ];
  const grouped = groupTranscriptParts(parts);
  assert.deepEqual(
    grouped.map((group) => [group.activity, group.parts.map((part) => part.partId)]),
    [
      [false, ['before']],
      [true, ['thought', 'call']],
      [false, ['between']],
      [true, ['result']],
      [false, ['after']],
    ],
  );
  assert.deepEqual(
    grouped.flatMap((group) => group.parts),
    parts,
  );
});
for (const state of ['failed', 'interrupted', 'running'] as const)
  test(`empty manifest retains preview ${state} evidence for the exact originating call`, () => {
    const call = part('call', 'arguments', { state: 'requested' });
    const origin = transcript('origin', [call]);
    const result = transcript('result', [
      part('result', 'result', {
        role: 'tool',
        state,
        pairing: 'matched',
        call: { entryId: 'origin', partId: 'call' },
      }),
    ]);
    const entries: ChatEntry[] = [
      { id: 'origin', role: 'assistant', text: '', truncated: false, transcript: origin },
      { id: 'result', role: 'tool', text: '', truncated: false, transcript: result },
    ];
    for (const manifest of [null, { source: result.source, parts: [] }]) {
      const evidence = collectActivityEvidence(getEntryTranscripts(entries, manifest));
      assert.equal(getActivityState(call, origin, evidence), state);
    }
  });
test('only a nonempty manifest with the exact result source can replace preview evidence', () => {
  const result = transcript('result', [part('result', 'result', { state: 'failed' })]);
  const entries: ChatEntry[] = [
    { id: 'result', role: 'tool', text: '', truncated: false, transcript: result },
  ];
  const loaded = { ...result, parts: [part('result', 'result', { state: 'completed' })] };
  assert.equal(getEntryTranscripts(entries, loaded)[0]?.parts[0]?.state, 'completed');
  const foreignTarget = structuredClone(loaded);
  foreignTarget.source.target.host.storeId = 'other';
  for (const manifest of [transcript('other-entry', loaded.parts), foreignTarget])
    assert.equal(getEntryTranscripts(entries, manifest)[0]?.parts[0]?.state, 'failed');
});
test('reused IDs, names and ambiguous results never provide another originating call state', () => {
  const call = part('call', 'arguments', {
    callId: 'reused',
    toolName: 'read',
    state: 'requested',
  });
  const first = transcript('first', [call]),
    second = transcript('second', [call]);
  const result = part('result', 'result', {
    role: 'tool',
    callId: 'reused',
    toolName: 'read',
    state: 'failed',
    pairing: 'matched',
    call: { entryId: 'first', partId: 'call' },
  });
  const evidence = collectActivityEvidence([
    first,
    second,
    transcript('result', [result]),
    transcript('ambiguous', [
      { ...result, pairing: 'ambiguous', call: { entryId: 'second', partId: 'call' } },
    ]),
  ]);
  assert.equal(getActivityState(call, first, evidence), 'failed');
  assert.equal(getActivityState(call, second, evidence), 'requested');
  const foreign = transcript('first', [call]);
  foreign.source.target.host.storeId = 'other';
  assert.equal(getActivityState(call, foreign, evidence), 'requested');
  assert.equal(getToolSummary({ ...call, text: '{"path":"src/moon.ts"}' }), 'read · src/moon.ts');
  assert.equal(
    getToolSummary({ ...call, toolName: 'bash', text: '{"command":"printf moon\\n"}' }),
    'bash · printf moon ',
  );
  assert.equal(
    getToolSummary({ ...call, toolName: 'unknown', text: '{"path":"not a known summary"}' }),
    'unknown',
  );
});
test('recorded unified hunks expose actual old/new coordinates, additions, removals and EOF notices', () => {
  const result = parseRecordedPatch(
    '--- a/gone.ts\n+++ b/gone.ts\n@@ -41,3 +80,4 @@\n same\n-old\n+new\n+more\n last\n\\ No newline at end of file\n@@ -90,0 +130,1 @@\n+added\n',
  );
  assert.ok('files' in result);
  assert.equal(result.files[0]!.old, 'a/gone.ts');
  assert.deepEqual(result.files[0]!.hunks[0]!.lines, [
    { old: 41, next: 80, kind: 'context', text: ' same' },
    { old: 42, kind: 'removed', text: '-old' },
    { next: 81, kind: 'added', text: '+new' },
    { next: 82, kind: 'added', text: '+more' },
    { old: 43, next: 83, kind: 'context', text: ' last' },
    { kind: 'notice', text: '\\ No newline at end of file' },
  ]);
  assert.deepEqual(result.files[0]!.hunks[1]!.lines, [
    { next: 130, kind: 'added', text: '+added' },
  ]);
});
test('incomplete, malformed, unsupported and huge patches return readable labelled fallback', () => {
  for (const source of [
    '',
    '@@ broken @@\n-old\n+new\n',
    '@@ -1,3 +1 @@\n-old\n+new\n',
    '@@ -0,1 +1,1 @@\n-old\n+new\n',
    'GIT binary patch\nliteral 0\n',
    '@@ -9999999999999999999 +1 @@\n-old\n+new\n',
    'x'.repeat(65537),
    '\n'.repeat(2001),
  ])
    assert.ok('fallback' in parseRecordedPatch(source));
  assert.ok('fallback' in parseRecordedPatch('@@ -1 +1 @@\n-old\n+new\n', false));
});
for (const [name, source] of [
  ['header only', '@@ -1 +1 @@'],
  ['missing added line', '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old'],
  ['missing removed line', '--- a/x\n+++ b/x\n@@ -1 +1 @@\n+new'],
  [
    'missing added line with EOF notice',
    '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n\\ No newline at end of file',
  ],
] as const)
  test(`EOF-truncated patch gets labelled source fallback: ${name}`, () => {
    const result = parseRecordedPatch(source);
    assert.ok('fallback' in result);
    assert.match(result.fallback, /Malformed or unsupported/);
  });

for (const [name, hunk, lines] of [
  [
    'replacement',
    '@@ -1 +1 @@\n-old\n+new',
    [
      { old: 1, kind: 'removed', text: '-old' },
      { next: 1, kind: 'added', text: '+new' },
    ],
  ],
  ['insertion', '@@ -1,0 +2 @@\n+new', [{ next: 2, kind: 'added', text: '+new' }]],
  ['deletion', '@@ -1 +1,0 @@\n-old', [{ old: 1, kind: 'removed', text: '-old' }]],
  [
    'replacement with EOF notice',
    '@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file',
    [
      { old: 1, kind: 'removed', text: '-old' },
      { next: 1, kind: 'added', text: '+new' },
      { kind: 'notice', text: '\\ No newline at end of file' },
    ],
  ],
] as const)
  test(`valid patch without terminal newline retains recorded line coordinates: ${name}`, () => {
    const result = parseRecordedPatch('--- a/x\n+++ b/x\n' + hunk);
    assert.ok('files' in result);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]!.hunks.length, 1);
    assert.deepEqual(result.files[0]!.hunks[0]!.lines, lines);
  });
