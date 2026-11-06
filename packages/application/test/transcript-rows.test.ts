import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatSnapshot } from '@moonbase/contracts/chat';
import { transcriptLimits } from '@moonbase/application/chat';
import { part, transcriptController } from './transcript-fixture.ts';

function running(snapshot: ChatSnapshot, text: string, transcript = true): ChatSnapshot {
  const target = snapshot.conversation.target;
  const source = {
    kind: 'live' as const,
    target,
    submissionId: 'send',
    taskId: 'task',
    attempt: 0,
    incarnation: 'a'.repeat(64),
  };
  return {
    ...snapshot,
    state: 'running',
    run: {
      stop: { target, submissionId: 'send', taskId: 'task' },
      state: 'running',
      text,
      truncated: false,
      tools: transcript
        ? []
        : [
            { taskId: 'tool-1', name: 'bash', state: 'running', text: 'first', truncated: false },
            { taskId: 'tool-2', name: 'read', state: 'completed', text: 'second', truncated: true },
          ],
      ...(transcript
        ? {
            transcript: {
              source,
              parts: [part('m0.b0', text)],
              thinking: 'pending' as const,
              nextCursor: null,
            },
          }
        : {}),
    },
  };
}
const rowKeys = (f: Awaited<ReturnType<typeof transcriptController>>) =>
  f.controller.getSnapshot().transcript.rows.map((row) => row.key);

test('rows are keyed by entry and keep their identity while unchanged', async (t) => {
  const f = await transcriptController(t, 640);
  const first = f.controller.getSnapshot().transcript;
  assert.deepEqual(
    first.rows.map((row) => row.key),
    first.entries.map((entry) => `entry:${entry.id}`),
  );
  assert(
    first.rows.every((row, index) => row.kind === 'entry' && row.entry === first.entries[index]),
  );
  // An identical snapshot publishes nothing new; an unrelated change keeps every row.
  f.publish(structuredClone(f.snapshot));
  assert.equal(f.controller.getSnapshot().transcript.rows, first.rows);
  f.publish({ ...f.snapshot, message: 'unrelated' });
  assert.equal(f.controller.getSnapshot().transcript.rows, first.rows);
  // A page read prepends rows and reuses the ones already published.
  await f.controller.showEarlier();
  const paged = f.controller.getSnapshot().transcript.rows;
  const added = paged.length - first.rows.length;
  assert(added > 0);
  assert(paged.slice(added).every((row, index) => row === first.rows[index]));
});

test('the live response and legacy tool previews are rows after the stored entries', async (t) => {
  const f = await transcriptController(t, 64);
  const stored = f.controller.getSnapshot().transcript.rows;
  f.publish(running(f.snapshot, 'one'));
  let rows = f.controller.getSnapshot().transcript.rows;
  const live = rows.at(-1)!;
  assert.equal(live.key, 'live:send');
  assert(live.kind === 'live' && live.state === 'running');
  assert.equal(live.entry.text, 'one');
  assert.equal(live.entry.transcript?.source.kind, 'live');
  assert(rows.slice(0, -1).every((row, index) => row === stored[index]));
  // Progress replaces only the live row; it keeps its key across updates.
  f.publish(running(f.snapshot, 'one two'));
  rows = f.controller.getSnapshot().transcript.rows;
  assert.notEqual(rows.at(-1), live);
  assert.equal(rows.at(-1)!.key, 'live:send');
  assert(rows.slice(0, -1).every((row, index) => row === stored[index]));
  // A host without transcripts shows its tool previews as their own rows.
  f.publish(running(f.snapshot, 'legacy', false));
  assert.deepEqual(rowKeys(f).slice(-3), ['live:send', 'tool:tool-1', 'tool:tool-2']);
  const tools = f.controller.getSnapshot().transcript.rows.slice(-2);
  assert(tools[0]!.kind === 'tool' && tools[0]!.tool.name === 'bash');
  f.publish({ ...running(f.snapshot, 'legacy', false), message: 'unrelated' });
  assert(
    f.controller
      .getSnapshot()
      .transcript.rows.slice(-2)
      .every((row, i) => row === tools[i]),
  );
  // One preview changing replaces only its row; the live row and the other preview stay.
  const legacy = f.controller.getSnapshot().transcript.rows.slice(-3);
  const changed = running(f.snapshot, 'legacy', false);
  changed.run!.tools[1] = { ...changed.run!.tools[1]!, text: 'second, more' };
  f.publish(changed);
  const next = f.controller.getSnapshot().transcript.rows.slice(-3);
  assert.equal(next[0], legacy[0]);
  assert.equal(next[1], legacy[1]);
  assert.notEqual(next[2], legacy[2]);
  f.publish({ ...f.snapshot, run: null, state: 'idle' });
  assert.deepEqual(
    rowKeys(f),
    stored.map((row) => row.key),
  );
});

test('reading history around an entry hides the live row until later history returns to it', async (t) => {
  const f = await transcriptController(t, 640);
  f.publish(running(f.snapshot, 'live'));
  const dataset = f.controller.getSnapshot().transcript.dataset;
  assert.equal(await f.controller.jumpToEntry('e100'), 'entry:e100');
  let state = f.controller.getSnapshot().transcript;
  assert.equal(state.dataset, dataset + 1, 'a jump replaces the rows');
  assert(state.earlier && state.later);
  assert.equal(state.atLatest, false);
  assert(!state.rows.some((row) => row.kind === 'live'));
  assert.equal(state.view.anchor?.key, 'entry:e100');
  for (let step = 0; step < 40 && f.controller.getSnapshot().transcript.later; step++)
    await f.controller.showLater();
  state = f.controller.getSnapshot().transcript;
  assert.equal(state.later, false);
  assert.equal(state.atLatest, true, 'reaching the newest entry follows the live edge again');
  assert.equal(state.dataset, dataset + 1, 'later pages extend the rows');
  assert.equal(state.rows.at(-1)!.key, 'live:send');
  assert.equal(state.entries.at(-1)!.id, 'e639');
});

test('earlier pages past the record budget evict from the newer end but never the anchor row', async (t) => {
  const f = await transcriptController(t, 2400);
  f.controller.setTranscriptView({ anchor: { key: 'entry:e2399', offset: -8 }, expanded: [] });
  let state = f.controller.getSnapshot().transcript;
  assert(state.earlier && !state.later);
  for (let step = 0; step < 100 && f.controller.getSnapshot().transcript.earlier; step++) {
    await f.controller.showEarlier();
    state = f.controller.getSnapshot().transcript;
    assert.equal(state.error, null);
    assert(state.entries.length <= transcriptLimits.summaryRecords);
    assert(
      state.entries.some((entry) => entry.id === 'e2399'),
      'the anchor row stays',
    );
  }
  assert.equal(state.earlier, false);
  assert.equal(state.entries[0]!.id, 'e0');
  assert.equal(state.later, true, 'evicted newer history reads again later');
  assert(!state.entries.some((entry) => entry.id === 'e2398'));
  assert.equal(state.view.anchor?.key, 'entry:e2399');
});

test('a jump to a retained entry reads nothing and keeps the rows', async (t) => {
  const f = await transcriptController(t, 640);
  const before = f.controller.getSnapshot().transcript;
  const reads = f.calls.length;
  assert.equal(await f.controller.jumpToEntry('e620'), 'entry:e620');
  const after = f.controller.getSnapshot().transcript;
  assert.equal(f.calls.length, reads);
  assert.equal(after.rows, before.rows);
  assert.equal(after.dataset, before.dataset);
  assert.deepEqual(after.view.anchor, { key: 'entry:e620', offset: 0 });
  assert.equal(await f.controller.jumpToEntry('missing'), null);
  assert(f.controller.getSnapshot().transcript.error);
});
