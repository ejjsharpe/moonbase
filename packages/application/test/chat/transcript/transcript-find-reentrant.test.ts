import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect } from 'effect';
import { transcriptHarness } from './transcript-fixture.ts';

// A subscriber that acts on Find's first publication runs before the search reads anything.

test('closing Find from the initial searching publication leaves Find closed and idle', async (t) => {
  const f = await transcriptHarness(t, 3);
  let acted = false;
  f.onPublish = (state) =>
    Effect.suspend(() => {
      if (acted || state.find.status !== 'searching') return Effect.void;
      acted = true;
      return Effect.promise(() => f.transcript.closeFind());
    });
  await f.transcript.findTranscript('same');
  const find = f.state.find;
  assert.equal(acted, true);
  assert.equal(find.open, false);
  assert.equal(find.status, 'idle');
  assert.equal(find.error, null);
  assert(!f.calls.some((call) => call.operation === 'findChatTranscript'));
});

test('replacing Find from the initial searching publication does not poison the successor', async (t) => {
  const f = await transcriptHarness(t, 3);
  let acted = false;
  const errors: string[] = [];
  f.onPublish = (state) =>
    Effect.suspend(() => {
      if (state.find.query === 'different' && state.find.error) errors.push(state.find.error);
      if (acted || state.find.query !== 'same' || state.find.status !== 'searching')
        return Effect.void;
      acted = true;
      return Effect.promise(() => f.transcript.findTranscript('different'));
    });
  await f.transcript.findTranscript('same');
  const find = f.state.find;
  assert.equal(find.query, 'different');
  assert.equal(find.status, 'complete');
  assert.equal(find.error, null);
  assert.deepEqual(errors, []);
});
