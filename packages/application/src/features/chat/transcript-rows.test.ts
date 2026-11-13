import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatSnapshot } from '@moonbase/contracts/chat';
import { transcriptLimits } from '@moonbase/application/chat';
import { part, transcriptController } from '../../../test/fixtures/transcript-fixture.ts';

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
      ...(transcript
        ? {
            transcript: {
              source,
              parts: [part('m0.b0', text)],
              thinking: 'none' as const,
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

test('the live response is a row after the stored entries', async (t) => {
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
  // A run whose task is completing has no transcript; its live row shows the text preview alone.
  f.publish(running(f.snapshot, 'completing', false));
  assert.deepEqual(rowKeys(f).slice(-2), [stored.at(-1)!.key, 'live:send']);
  const completing = f.controller.getSnapshot().transcript.rows.at(-1)!;
  assert(completing.kind === 'live' && !completing.entry.transcript);
  assert.equal(completing.entry.text, 'completing');
  f.publish({ ...running(f.snapshot, 'completing', false), message: 'unrelated' });
  assert.equal(f.controller.getSnapshot().transcript.rows.at(-1), completing);
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
  await f.controller.jumpToEntry('e100');
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

test('a jump to a retained entry reads nothing and places the same rows afresh', async (t) => {
  const f = await transcriptController(t, 640);
  const before = f.controller.getSnapshot().transcript;
  const reads = f.calls.length;
  await f.controller.jumpToEntry('e620');
  const after = f.controller.getSnapshot().transcript;
  assert.equal(f.calls.length, reads);
  assert.equal(after.rows, before.rows);
  assert.equal(after.dataset, before.dataset + 1);
  assert.deepEqual(after.view.anchor, { key: 'entry:e620', offset: 0 });
  await f.controller.jumpToEntry('missing');
  assert(f.controller.getSnapshot().transcript.error);
});
