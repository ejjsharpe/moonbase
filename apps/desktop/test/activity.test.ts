import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatTranscript, ChatTranscriptPart } from '@moonbase/contracts/chat';
import {
  collectActivityEvidence,
  getActivityState,
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
