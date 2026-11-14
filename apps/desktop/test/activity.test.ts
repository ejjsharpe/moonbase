import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatEntry, ChatTranscript, ChatTranscriptPart } from '@moonbase/contracts/chat';
import {
  classifyEntry,
  collectActivityEvidence,
  describeActivityHeadline,
  findAnsweredThoughts,
  findReadingAnchor,
  getActivityState,
  getEntryTranscripts,
  getThoughtLine,
  getToolSummary,
  groupActivitySteps,
  groupTranscriptParts,
  isEmptyThought,
  splitCommand,
  summarizeActivityHeadlines,
  type ActivityHeadline,
  groupTranscriptRows,
  type TranscriptItem,
} from '../src/renderer/chat/transcript/activity.ts';
import {
  parseRecordedPatch,
  type PatchLine,
} from '../src/renderer/chat/transcript/recorded-patch.ts';
import { getTranscriptParts } from '../src/renderer/chat/transcript/transcript-parts.ts';
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
/** Checks each line's source offset is a whole source line equal to it, then drops the offsets. */
function checkLineStarts(source: string, lines: readonly PatchLine[]) {
  return lines.map(({ start, ...line }) => {
    assert.ok(start !== undefined);
    assert.equal(source.slice(start, start + line.text.length), line.text);
    assert.ok(start === 0 || source[start - 1] === '\n');
    return line;
  });
}
test('recorded unified hunks expose actual old/new coordinates, additions, removals and EOF notices', () => {
  // A removed empty line ('-') must not be located inside the '--- a/…' header.
  const source =
    '--- a/gone.ts\n+++ b/gone.ts\n@@ -41,4 +80,4 @@\n same\n-\n-old\n+new\n+more\n last\n\\ No newline at end of file\n@@ -90,0 +130,1 @@\n+added\n';
  const result = parseRecordedPatch(source);
  assert.ok('files' in result);
  assert.equal(result.files[0]!.old, 'a/gone.ts');
  assert.equal(result.files[0]!.hunks[0]!.lines[1]!.start, source.indexOf('\n-\n') + 1);
  assert.deepEqual(checkLineStarts(source, result.files[0]!.hunks[0]!.lines), [
    { old: 41, next: 80, kind: 'context', text: ' same' },
    { old: 42, kind: 'removed', text: '-' },
    { old: 43, kind: 'removed', text: '-old' },
    { next: 81, kind: 'added', text: '+new' },
    { next: 82, kind: 'added', text: '+more' },
    { old: 44, next: 83, kind: 'context', text: ' last' },
    { kind: 'notice', text: '\\ No newline at end of file' },
  ]);
  assert.deepEqual(checkLineStarts(source, result.files[0]!.hunks[1]!.lines), [
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
    const source = '--- a/x\n+++ b/x\n' + hunk;
    const result = parseRecordedPatch(source);
    assert.ok('files' in result);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]!.hunks.length, 1);
    assert.deepEqual(checkLineStarts(source, result.files[0]!.hunks[0]!.lines), lines);
  });

test('a thought reads as its opening heading, else its first sentence, without Markdown marks', () => {
  assert.equal(getThoughtLine('**Finding the logger**\n\nLet me search.'), 'Finding the logger');
  assert.equal(
    getThoughtLine('Let me check `app.ts` first. Then run tests.'),
    'Let me check app.ts first.',
  );
  assert.equal(getThoughtLine('- [the docs](https://example.com) say so'), 'the docs say so');
  assert.equal(getThoughtLine('   '), '');
});

test('a shell line names the program it runs past cd hops, assignments and wrappers', () => {
  assert.deepEqual(splitCommand('cd /work/app && rg -n "logger" src'), {
    program: 'rg',
    rest: '-n "logger" src',
  });
  assert.deepEqual(splitCommand('FOO=1 sudo npm test -- logger'), {
    program: 'npm',
    rest: 'test -- logger',
  });
  assert.deepEqual(splitCommand('/usr/bin/python3 -m http.server'), {
    program: 'python3',
    rest: '-m http.server',
  });
  assert.equal(splitCommand('cd /work/app'), undefined);
  // A word that also appears in an assignment, and wrapper options with values.
  assert.deepEqual(splitCommand('FOO=npm npm test'), { program: 'npm', rest: 'test' });
  assert.deepEqual(splitCommand('sudo -u root ls -la'), { program: 'ls', rest: '-la' });
  assert.deepEqual(splitCommand('env -u HOME FOO=1 nice -n 5 node app.js'), {
    program: 'node',
    rest: 'app.js',
  });
});

test('a step headline takes the tense of its state and its output from another row', () => {
  const headline = (parts: ChatTranscriptPart[], answers: ChatTranscript[] = []) => {
    const origin = transcript('origin', parts);
    const evidence = collectActivityEvidence([origin, ...answers]);
    return groupActivitySteps(origin.parts, 'origin').map((step) =>
      describeActivityHeadline(step, origin, evidence),
    );
  };
  const answer = (state: ChatTranscriptPart['state'], extra: ChatTranscriptPart[] = []) =>
    transcript('result', [
      part('result', 'result', {
        role: 'tool',
        state,
        pairing: 'matched',
        call: { entryId: 'origin', partId: 'call' },
        text: 'output',
      }),
      ...extra,
    ]);
  const call = (toolName: string, args: object) =>
    part('call', 'arguments', { toolName, state: 'requested', text: JSON.stringify(args) });

  assert.deepEqual(
    headline([call('bash', { command: 'cd app && npm test' })], [answer('running')]),
    [{ category: 'command', action: 'Running npm', detail: 'test' }],
  );
  assert.deepEqual(headline([call('bash', { command: 'npm test' })], [answer('failed')]), [
    { category: 'command', action: 'Ran npm', detail: 'test', problem: 'failed' },
  ]);
  assert.deepEqual(
    headline([call('read', { path: 'src/server/logger.ts' })], [answer('completed')]),
    [{ category: 'read', action: 'Read logger.ts', detail: 'src/server' }],
  );
  const patch = part('patch', 'patch', {
    role: 'tool',
    pairing: 'matched',
    call: { entryId: 'origin', partId: 'call' },
    text: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
  });
  assert.deepEqual(headline([call('edit', { path: 'src/a.ts' })], [answer('completed', [patch])]), [
    { category: 'edit', action: 'Edited a.ts', detail: '+1 −1 · src', path: 'src/a.ts' },
  ]);
  assert.deepEqual(headline([call('unknown', { opaque: true })], [answer('missing-result')]), [
    { category: 'tool', action: 'Used unknown', detail: '', problem: 'no result' },
  ]);
  assert.deepEqual(
    headline([part('thought', 'thinking', { text: '**Checking the tests**\n\nRun them.' })]),
    [{ category: 'thinking', action: 'Checking the tests', detail: '' }],
  );
  assert.deepEqual(headline([part('hidden', 'thinking', { availability: 'redacted' })]), [
    { category: 'thinking', action: 'Thought', detail: 'redacted' },
  ]);
  // Consecutive thinking blocks are one thought, read from its first block.
  assert.deepEqual(
    headline([
      part('thought', 'thinking', { text: 'First block.' }),
      part('more', 'thinking', { text: 'Second block.' }),
      call('read', { path: 'a.ts' }),
    ]).map((step) => step.action),
    ['First block.', 'Read a.ts'],
  );
  // A saved call whose result isn't among the rows read isn't still running.
  assert.deepEqual(headline([call('read', { path: 'a.ts' })]), [
    { category: 'read', action: 'Read a.ts', detail: '', problem: 'no result shown' },
  ]);
  // Thoughts apart from each other stay apart, even with another step's output between them.
  assert.equal(
    groupActivitySteps(
      [
        call('bash', { command: 'ls' }),
        part('one', 'thinking', { text: 'One.' }),
        part('out', 'result', {
          role: 'tool',
          pairing: 'matched',
          call: { entryId: 'origin', partId: 'call' },
        }),
        part('two', 'thinking', { text: 'Two.' }),
      ],
      'origin',
    ).length,
    3,
  );
});

test('a thought with nothing to read is no step, and a reply that only had one is empty', () => {
  const empty = part('signature', 'thinking');
  const read = part('read', 'arguments', { toolName: 'read', text: '{"path":"a.ts"}' });
  // Only an available thought whose whole text is blank is empty; redacted and cut ones show.
  assert.equal(isEmptyThought(empty), true);
  assert.equal(isEmptyThought(part('blank', 'thinking', { text: ' \n', bytes: 2 })), true);
  assert.equal(isEmptyThought(part('hidden', 'thinking', { availability: 'redacted' })), false);
  assert.equal(isEmptyThought(part('cut', 'thinking', { truncated: true, bytes: 9000 })), false);
  assert.equal(isEmptyThought(part('text', 'text')), false);
  assert.deepEqual(
    groupActivitySteps([empty, read]).map((step) => step.lead.partId),
    ['read'],
  );
  // An empty thought between two thoughts doesn't split them.
  assert.deepEqual(
    groupActivitySteps([
      part('one', 'thinking', { text: 'One.' }),
      empty,
      part('two', 'thinking', { text: 'Two.' }),
    ]).map((step) => [step.lead.partId, step.answers.map((answer) => answer.partId)]),
    [['one', ['two']]],
  );
  const entry = (text: string, parts: ChatTranscriptPart[]): ChatEntry => ({
    id: 'entry',
    role: 'assistant',
    text,
    truncated: false,
    transcript: transcript('entry', parts),
  });
  assert.equal(classifyEntry(entry('', [empty])), 'empty');
  assert.equal(classifyEntry(entry('', [empty, read])), 'activity');
  assert.equal(classifyEntry(entry('Yes.', [empty, part('answer', 'text')])), 'message');
});

test('reply text takes the place of the thoughts it follows; thoughts before tool work stay', () => {
  const thought = (id: string) => part(id, 'thinking', { text: `${id}.`, bytes: 4 });
  assert.deepEqual(
    [
      ...findAnsweredThoughts([
        thought('a'),
        thought('b'),
        part('answer', 'text', { text: 'Yes.' }),
        thought('c'),
        part('call', 'arguments', { toolName: 'read' }),
        part('after', 'text', { text: 'Done.' }),
        thought('d'),
        // A tool's own text is no reply.
        part('output', 'text', { role: 'tool' }),
        part('last', 'text', { text: 'Done.' }),
        thought('trailing'),
      ]),
    ],
    ['a', 'b'],
  );
});

test('a folded summary counts steps by kind, each edited file once, and leaves thinking out', () => {
  const step = (category: ActivityHeadline['category'], path?: string): ActivityHeadline => ({
    category,
    action: '',
    detail: '',
    ...(path ? { path } : {}),
  });
  assert.equal(
    summarizeActivityHeadlines([
      step('thinking'),
      step('command'),
      step('read'),
      step('command'),
      step('edit', 'a.ts'),
      step('edit', 'a.ts'),
      step('edit', 'b.ts'),
      step('tool'),
    ]),
    'Ran 2 commands, read 1 file, edited 2 files, used 1 tool',
  );
  assert.equal(summarizeActivityHeadlines([step('thinking')]), 'Thought');
});

type GroupedRow = { key: string; kind: 'entry' | 'live'; read: 'activity' | 'message' | 'empty' };
const row = (key: string, read: GroupedRow['read'] = 'activity'): GroupedRow => ({
  key,
  kind: key.startsWith('live:') ? 'live' : 'entry',
  read,
});
const group = (
  rows: GroupedRow[],
  previous: readonly TranscriptItem<GroupedRow>[] = [],
  following = false,
) => groupTranscriptRows(rows, (value) => value.read, previous, following);
const keysOf = (items: readonly TranscriptItem<GroupedRow>[]) =>
  items.map((item) => [item.key, item.rows.map((value) => value.key)]);

test('an activity card keeps its list key as rows join its start or end, and as the live row leaves it the part the reader is in keeps it', () => {
  const question = row('entry:q', 'message'),
    call = row('entry:call'),
    output = row('entry:output'),
    earlier = row('entry:earlier'),
    marker = row('entry:marker', 'empty');
  let items = group([question, call]);
  assert.deepEqual(keysOf(items), [
    ['entry:q', ['entry:q']],
    ['entry:call', ['entry:call']],
  ]);
  // The live response joins the card's end.
  const live = row('live:submission');
  items = group([question, call, marker, live], items);
  assert.deepEqual(keysOf(items), [
    ['entry:q', ['entry:q']],
    ['entry:call', ['entry:call', 'live:submission']],
  ]);
  // A stored output joins before the live row, and history loading above joins the start.
  items = group([earlier, call, output, live], items);
  assert.deepEqual(keysOf(items), [
    ['entry:call', ['entry:earlier', 'entry:call', 'entry:output', 'live:submission']],
  ]);
  // The live row leaves as the answer starts. A reader following the live edge keeps the running
  // response mounted; the stored rows have an item of their own.
  const answering = row('live:submission', 'message');
  assert.deepEqual(keysOf(group([earlier, call, output, answering], items, true)), [
    ['entry:output', ['entry:earlier', 'entry:call', 'entry:output']],
    ['entry:call', ['live:submission']],
  ]);
  // A reader scrolled up into the card keeps the card mounted instead.
  const split = group([earlier, call, output, answering], items);
  assert.deepEqual(keysOf(split), [
    ['entry:call', ['entry:earlier', 'entry:call', 'entry:output']],
    ['live:submission', ['live:submission']],
  ]);
  // Unchanged rows keep the item itself.
  const again = group([earlier, call, output, answering], split);
  assert.equal(again[0], split[0]);
  assert.equal(again[1], split[1]);
  // Rows replaced with equal keys (an updated entry) keep the key too.
  assert.deepEqual(
    keysOf(group([row('entry:earlier'), row('entry:call'), row('entry:output'), answering], split)),
    keysOf(split),
  );
});

test('a split card never gives two items one key', () => {
  const question = row('entry:q', 'message'),
    tool = row('entry:tool');
  // The live row's thinking starts a card, so the card is keyed by the live row.
  let items = group([question, row('live:s')]);
  items = group([question, tool, row('live:s')], items);
  assert.deepEqual(keysOf(items), [
    ['entry:q', ['entry:q']],
    ['live:s', ['entry:tool', 'live:s']],
  ]);
  assert.deepEqual(keysOf(group([question, tool, row('live:s', 'message')], items, true)), [
    ['entry:q', ['entry:q']],
    ['entry:tool', ['entry:tool']],
    ['live:s', ['live:s']],
  ]);
  // Not following, the stored row keeps the card's key, and the live row takes an unclaimed one.
  const split = group([question, tool, row('live:s', 'message')], items);
  assert.deepEqual(keysOf(split), [
    ['entry:q', ['entry:q']],
    ['live:s', ['entry:tool']],
    ['live:s#1', ['live:s']],
  ]);
  // A stored row keyed like a claimed key takes an unclaimed one.
  const stored = group([row('entry:a'), row('entry:b')]);
  const regrouped = group([row('entry:a'), row('entry:x', 'message'), row('entry:b')], stored);
  const keys = regrouped.map((item) => item.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("a reading anchor names a stored row and the offset from that row's own top", () => {
  const items = group([
    row('entry:q', 'message'),
    row('entry:a'),
    row('entry:b'),
    row('entry:c'),
    row('live:s'),
  ]);
  // Rows of the card are 20px apart; the live row is 60px into it.
  const tops: Record<string, number> = { 'entry:b': 20, 'entry:c': 40, 'live:s': 60 };
  const measured: string[] = [];
  const geometry = {
    measure: (key: string) => (measured.push(key), 640),
    rowTop: (key: string) => tops[key],
  };
  const card = items[1]!.key;
  // The viewport top is 5px into b, so a restore that reads fewer rows above b still finds it.
  assert.deepEqual(findReadingAnchor(items, { key: card, offset: 25 }, geometry), {
    key: 'entry:b',
    offset: 5,
  });
  // A row landed a fraction of a pixel below the viewport top still holds it.
  assert.deepEqual(findReadingAnchor(items, { key: card, offset: 19.6 }, geometry), {
    key: 'entry:b',
    offset: 19.6 - 20,
  });
  // Above the card's top it names the first row, with a negative offset.
  assert.deepEqual(findReadingAnchor(items, { key: card, offset: -8 }, geometry), {
    key: 'entry:a',
    offset: -8,
  });
  // In the card's live row it names the stored row above, never the live row.
  assert.deepEqual(findReadingAnchor(items, { key: card, offset: 70 }, geometry), {
    key: 'entry:c',
    offset: 30,
  });
  // An unmeasured row stops the search at the last measured stored row.
  assert.deepEqual(
    findReadingAnchor(items, { key: card, offset: 70 }, { ...geometry, rowTop: () => undefined }),
    { key: 'entry:a', offset: 70 },
  );
  assert.deepEqual(measured, []);
  // An open run's rows all sit below the run's line (35px), so offsets are from where they are.
  const below: Record<string, number> = {
    'entry:a': 35,
    'entry:b': 55,
    'entry:c': 75,
    'live:s': 95,
  };
  assert.deepEqual(
    findReadingAnchor(
      items,
      { key: card, offset: 50 },
      { ...geometry, rowTop: (key) => below[key] },
    ),
    { key: 'entry:a', offset: 15 },
  );
  // A folded run shows none of its rows: its first row names it, from the run's top.
  assert.deepEqual(
    findReadingAnchor(items, { key: card, offset: 10 }, { ...geometry, rowTop: () => undefined }),
    { key: 'entry:a', offset: 10 },
  );
  // A live row alone anchors to the last stored row before it, from that row's top.
  const alone = group([row('entry:q', 'message'), row('entry:r'), row('live:s', 'message')]);
  assert.deepEqual(findReadingAnchor(alone, { key: alone[2]!.key, offset: 12 }, geometry), {
    key: 'entry:r',
    offset: 640,
  });
  assert.deepEqual(measured, ['entry:r']);
  // With no stored row before it, it names itself; an unknown item names nothing.
  const first = group([row('live:s')]);
  assert.deepEqual(findReadingAnchor(first, { key: 'live:s', offset: 3 }, geometry), {
    key: 'live:s',
    offset: 3,
  });
  assert.equal(findReadingAnchor(first, { key: 'gone', offset: 3 }, geometry), undefined);
});
