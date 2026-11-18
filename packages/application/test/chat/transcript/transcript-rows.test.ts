import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatSnapshot } from '@moonbase/contracts/chat';
import {
  part,
  scaledTranscriptLimits,
  transcriptHarness,
  type TranscriptHarness,
} from './transcript-fixture.ts';

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
const rowKeys = (f: TranscriptHarness) => f.state.rows.map((row) => row.key);

test('rows are keyed by entry and keep their identity while unchanged', async (t) => {
  const f = await transcriptHarness(t, 640);
  const first = f.state;
  assert.deepEqual(
    first.rows.map((row) => row.key),
    first.entries.map((entry) => `entry:${entry.id}`),
  );
  assert(
    first.rows.every((row, index) => row.kind === 'entry' && row.entry === first.entries[index]),
  );
  // An identical snapshot publishes nothing new; an unrelated change keeps every row.
  await f.publish(structuredClone(f.snapshot));
  assert.equal(f.state.rows, first.rows);
  await f.publish({ ...f.snapshot, message: 'unrelated' });
  assert.equal(f.state.rows, first.rows);
  // A page read prepends rows and reuses the ones already published.
  await f.transcript.showEarlier();
  const paged = f.state.rows;
  const added = paged.length - first.rows.length;
  assert(added > 0);
  assert(paged.slice(added).every((row, index) => row === first.rows[index]));
});

test('the live response is a row after the stored entries', async (t) => {
  const f = await transcriptHarness(t, 64);
  const stored = f.state.rows;
  await f.publish(running(f.snapshot, 'one'));
  let rows = f.state.rows;
  const live = rows.at(-1)!;
  assert.equal(live.key, 'live:send');
  assert(live.kind === 'live' && live.state === 'running');
  assert.equal(live.entry.text, 'one');
  assert.equal(live.entry.transcript?.source.kind, 'live');
  assert(rows.slice(0, -1).every((row, index) => row === stored[index]));
  // Progress replaces only the live row; it keeps its key across updates.
  await f.publish(running(f.snapshot, 'one two'));
  rows = f.state.rows;
  assert.notEqual(rows.at(-1), live);
  assert.equal(rows.at(-1)!.key, 'live:send');
  assert.equal(rows.at(-1)!.entry.transcript?.source, live.entry.transcript?.source, 'same source');
  assert(rows.slice(0, -1).every((row, index) => row === stored[index]));
  // A run whose task is completing has no transcript; its live row shows the text preview alone.
  await f.publish(running(f.snapshot, 'completing', false));
  assert.deepEqual(rowKeys(f).slice(-2), [stored.at(-1)!.key, 'live:send']);
  const completing = f.state.rows.at(-1)!;
  assert(completing.kind === 'live' && !completing.entry.transcript);
  assert.equal(completing.entry.text, 'completing');
  await f.publish({ ...running(f.snapshot, 'completing', false), message: 'unrelated' });
  assert.equal(f.state.rows.at(-1), completing);
  await f.publish({ ...f.snapshot, run: null, state: 'idle' });
  assert.deepEqual(
    rowKeys(f),
    stored.map((row) => row.key),
  );
});

test('reading history around an entry hides the live row until later history returns to it', async (t) => {
  const f = await transcriptHarness(t, 640);
  await f.publish(running(f.snapshot, 'live'));
  const dataset = f.state.dataset;
  await f.transcript.jumpToEntry('e100');
  let state = f.state;
  assert.equal(state.dataset, dataset + 1, 'a jump replaces the rows');
  assert(state.earlier && state.later);
  assert.equal(state.atLatest, false);
  assert(!state.rows.some((row) => row.kind === 'live'));
  assert.equal(state.view.anchor?.key, 'entry:e100');
  for (let step = 0; step < 40 && f.state.later; step++) await f.transcript.showLater();
  state = f.state;
  assert.equal(state.later, false);
  assert.equal(state.dataset, dataset + 1, 'later pages extend the rows');
  assert.equal(state.rows.at(-1)!.key, 'live:send');
  assert.equal(state.entries.at(-1)!.id, 'e639');
});

test('earlier pages past the record budget evict from the newer end but never the anchor row', async (t) => {
  const f = await transcriptHarness(t, 300, { limits: scaledTranscriptLimits });
  await f.transcript.setView({ anchor: { key: 'entry:e299', offset: -8 }, expanded: [] });
  let state = f.state;
  assert(state.earlier && !state.later);
  for (let step = 0; step < 100 && f.state.earlier; step++) {
    await f.transcript.showEarlier();
    state = f.state;
    assert.equal(state.error, null);
    assert(state.entries.length <= f.limits.summaryRecords);
    assert(
      state.entries.some((entry) => entry.id === 'e299'),
      'the anchor row stays',
    );
  }
  assert.equal(state.earlier, false);
  assert.equal(state.entries[0]!.id, 'e0');
  assert.equal(state.later, true, 'evicted newer history reads again later');
  assert(!state.entries.some((entry) => entry.id === 'e298'));
  assert.equal(state.view.anchor?.key, 'entry:e299');
});

test('a jump to a retained entry reads nothing and places the same rows afresh', async (t) => {
  const f = await transcriptHarness(t, 640);
  const before = f.state;
  const reads = f.calls.length;
  await f.transcript.jumpToEntry('e620');
  const after = f.state;
  assert.equal(f.calls.length, reads);
  assert.equal(after.rows, before.rows);
  assert.equal(after.dataset, before.dataset + 1);
  assert.deepEqual(after.view.anchor, { key: 'entry:e620', offset: 0 });
  await f.transcript.jumpToEntry('missing');
  assert(f.state.error);
});
