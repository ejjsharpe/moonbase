import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transcriptController } from './transcript-fixture.ts';

test('closing Find from the initial searching publication leaves Find closed and idle', async (t) => {
  const f = await transcriptController(t, 3);
  let acted = false;
  const off = f.controller.subscribe(() => {
    if (!acted && f.controller.getSnapshot().transcript.find.status === 'searching') {
      acted = true;
      f.controller.closeFind();
    }
  });
  t.after(off);
  await f.controller.findTranscript('same');
  const s = f.controller.getSnapshot().transcript.find;
  assert.equal(acted, true);
  assert.equal(s.open, false);
  assert.equal(s.status, 'idle');
  assert.equal(s.error, null);
});

test('replacing Find from the initial searching publication does not poison the successor', async (t) => {
  const f = await transcriptController(t, 3);
  let acted = false,
    replacement: Promise<void> | undefined;
  const errors: string[] = [];
  const off = f.controller.subscribe(() => {
    const s = f.controller.getSnapshot().transcript.find;
    if (s.query === 'different' && s.error) errors.push(s.error);
    if (!acted && s.query === 'same' && s.status === 'searching') {
      acted = true;
      replacement = f.controller.findTranscript('different');
    }
  });
  t.after(off);
  await f.controller.findTranscript('same');
  await replacement;
  const s = f.controller.getSnapshot().transcript.find;
  assert.equal(s.query, 'different');
  assert.equal(s.status, 'complete');
  assert.equal(s.error, null);
  assert.deepEqual(errors, []);
});

test('connection generation replacement fences a held old Find error and keeps its actual read owned', async (t) => {
  const f = await transcriptController(t, 64, false);
  let release!: () => void, signal: AbortSignal | undefined;
  const held = new Promise<void>((r) => (release = r));
  f.handlers.set('findChatTranscript', async (_input, abort) => {
    signal = abort;
    await held;
    throw Error('OLD GENERATION');
  });
  const find = f.controller.findTranscript('same');
  for (let i = 0; i < 100 && !signal; i++) await new Promise((r) => setTimeout(r, 0));
  assert(signal);
  const disconnect = f.controller.disconnect();
  for (let i = 0; i < 100 && !signal.aborted; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(signal.aborted, true);
  release();
  await find;
  await disconnect;
  f.handlers.delete('findChatTranscript');
  await f.controller.connect();
  await f.controller.findTranscript('different');
  const state = f.controller.getSnapshot().transcript.find;
  assert.equal(state.query, 'different');
  assert.equal(state.status, 'complete');
  assert.equal(state.error, null);
});
