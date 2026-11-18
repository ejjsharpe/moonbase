import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatSnapshot } from '@moonbase/contracts/chat';
import { HostUnavailableError } from '@moonbase/contracts/host-errors';
import {
  digest,
  scaledTranscriptLimits,
  transcriptHarness,
  type TranscriptHarness,
} from './transcript-fixture.ts';

type Fixture = TranscriptHarness;

function appendEntries(f: Fixture, count: number) {
  for (let index = f.entries.length; index < count; index++) {
    const id = digest('following-entry-' + index).slice(0, 24);
    f.entries.push({
      ...f.entries[0],
      id,
      transcript: {
        ...f.entries[0].transcript!,
        source: { kind: 'entry', target: f.target, entryId: id },
      },
    });
  }
}
/** A latest snapshot that shares no entries with the retained records. */
async function publishDisjointLatest(f: Fixture, count: number) {
  appendEntries(f, count);
  await f.publish({
    ...f.snapshot,
    entries: f.entries.slice(-32).reverse(),
    transcriptBoundary: f.entries.at(-1)!.id,
    olderCursor: String(count - 32),
  });
}
/** Holds the next around-entry read until `release` is called. */
function holdAroundRead(f: Fixture) {
  const entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<void>();
  let holding = true;
  f.handlers.set('getChatHistoryAround', async (_input, _signal, fallback) => {
    const page = fallback();
    if (holding) {
      holding = false;
      entered.resolve();
      await held.promise;
    }
    return page;
  });
  return { entered: entered.promise, release: () => held.resolve() };
}
const isOriginal = (f: Fixture, count: number) => (entry: { id: string }) =>
  f.entries.findIndex((value) => value.id === entry.id) < count;
function runningRun(snapshot: ChatSnapshot): ChatSnapshot {
  const target = snapshot.conversation.target;
  return {
    ...snapshot,
    state: 'running',
    run: {
      stop: { target, submissionId: 'send', taskId: 'task' },
      state: 'running',
      text: 'working',
      truncated: false,
    },
  };
}

test('a reading anchor saved during an earlier read keeps the reader in history', async (t) => {
  const f = await transcriptHarness(t, 640);
  assert.equal(f.state.atLatest, true);
  const hold = holdAroundRead(f);
  try {
    // A following reader flings to the top; the list asks for earlier history at once.
    const reading = f.transcript.showEarlier();
    await hold.entered;
    // The scroll settles before the slow read lands, and saves where the reader stopped.
    await f.transcript.setView({ anchor: { key: 'entry:e608', offset: -4 }, expanded: [] });
    hold.release();
    await reading;
    let state = f.state;
    assert.equal(state.atLatest, false, 'the saved anchor wins over following');
    const dataset = state.dataset;
    await publishDisjointLatest(f, 704);
    state = f.state;
    assert.equal(state.dataset, dataset, 'the records the reader is in stay');
    assert(state.entries.some((entry) => entry.id === 'e608'));
    assert(state.entries.every(isOriginal(f, 640)));
    assert(state.later);
  } finally {
    hold.release();
  }
});

test('a failed page read leaves following as it was', async (t) => {
  const f = await transcriptHarness(t, 640);
  f.handlers.set('getChatHistoryAround', async () => {
    throw new HostUnavailableError({ reason: 'failed' });
  });
  await f.transcript.showEarlier();
  let state = f.state;
  assert.equal(state.error, new HostUnavailableError({ reason: 'failed' }).message);
  assert.equal(state.atLatest, true, 'the reader follows as before the read');
  await f.transcript.setView({ anchor: { key: 'entry:e620', offset: 0 }, expanded: [] });
  assert.equal(f.state.atLatest, false);
  await f.transcript.setView({ anchor: null, expanded: [] });
  state = f.state;
  assert.equal(state.atLatest, true, 'later view saves apply at once');
});

test('budget eviction outside a page read keeps the rows around a reader near the newest end', async (t) => {
  const f = await transcriptHarness(t, 300, { limits: scaledTranscriptLimits });
  await f.transcript.setView({ anchor: { key: 'entry:e290', offset: 0 }, expanded: [] });
  // Page earlier up to just below the record budget, so nothing has been evicted yet.
  while (f.state.entries.length + 32 <= f.limits.summaryRecords) await f.transcript.showEarlier();
  let state = f.state;
  assert.equal(state.entries.at(-1)!.id, 'e299');
  assert.equal(state.atLatest, false);
  const oldest = state.entries[0]!.id;
  // New snapshot entries the records don't hold push the summaries past the budget.
  await publishDisjointLatest(f, 364);
  state = f.state;
  assert.equal(state.error, null);
  assert(state.entries.length <= f.limits.summaryRecords);
  assert.deepEqual(
    state.entries.slice(-10).map((entry) => entry.id),
    Array.from({ length: 10 }, (_, index) => `e${290 + index}`),
    'the rows from the anchor to the newest retained entry stay',
  );
  assert.notEqual(state.entries[0]!.id, oldest, 'the far, older end is evicted');
  assert(state.earlier);
});

test('budget eviction outside a page read keeps the rows around a reader near the oldest end', async (t) => {
  const f = await transcriptHarness(t, 300, { limits: scaledTranscriptLimits });
  while (f.state.entries.length + 32 <= f.limits.summaryRecords) await f.transcript.showEarlier();
  const oldest = f.state.entries.slice(0, 10);
  await f.transcript.setView({
    anchor: { key: `entry:${oldest[0]!.id}`, offset: 0 },
    expanded: [],
  });
  await publishDisjointLatest(f, 364);
  const state = f.state;
  assert.equal(state.error, null);
  assert(state.entries.length <= f.limits.summaryRecords);
  assert.deepEqual(state.entries.slice(0, 10), oldest, 'the rows the reader is in stay');
  assert.notEqual(state.entries.at(-1)!.id, 'e299', 'the far, newer end is evicted');
  assert(state.later);
});

test('a live response anchor is at the live edge', async (t) => {
  const f = await transcriptHarness(t, 64);
  await f.publish(runningRun(f.snapshot));
  assert.equal(f.state.rows.at(-1)!.key, 'live:send');
  await f.transcript.setView({ anchor: { key: 'live:send', offset: -3 }, expanded: [] });
  assert.equal(f.state.atLatest, true);
  // A latest snapshot replaces the records for a reader at the live edge.
  const dataset = f.state.dataset;
  await publishDisjointLatest(f, 128);
  let state = f.state;
  assert.equal(state.dataset, dataset + 1);
  assert.equal(state.later, false);
  // Reopening with the live anchor follows the live edge rather than reading history.
  await f.transcript.setView({ anchor: { key: 'live:send', offset: -3 }, expanded: [] });
  f.snapshot = runningRun(f.snapshot);
  await f.reopen();
  await f.transcript.restoreView();
  state = f.state;
  assert.deepEqual(state.view.anchor, { key: 'live:send', offset: -3 });
  assert.equal(state.atLatest, true);
  assert.equal(
    f.calls.filter((call) => call.operation === 'getChatHistoryAround').length,
    0,
    'a live-edge anchor restores without a history read',
  );
  const dataset2 = state.dataset;
  await publishDisjointLatest(f, 192);
  state = f.state;
  assert.equal(state.dataset, dataset2 + 1);
  assert.equal(state.later, false);
});

test('an earlier page that evicts the newest records stops following', async (t) => {
  const f = await transcriptHarness(t, 300, { limits: scaledTranscriptLimits });
  // The reader flings up from the live edge faster than scrolling saves an anchor.
  for (let step = 0; step < 100 && !f.state.later; step++) await f.transcript.showEarlier();
  let state = f.state;
  assert(state.later, 'the newest records were evicted');
  assert.equal(state.atLatest, false);
  assert(state.entries.length <= f.limits.summaryRecords);
  const { dataset } = state,
    oldest = state.entries[0]!.id;
  // A newer snapshot leaves the history the reader paged to rather than jumping to it.
  await publishDisjointLatest(f, 301);
  state = f.state;
  assert.equal(state.dataset, dataset);
  assert.equal(state.entries[0]!.id, oldest);
  assert(state.later);
  assert.equal(state.atLatest, false);
});
