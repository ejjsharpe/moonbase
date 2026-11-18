import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { TranscriptView } from '@moonbase/application/chat';
import type { ChatSnapshot, ChatTranscriptSource } from '@moonbase/contracts/chat';
import { TranscriptReadError } from '@moonbase/application/chat';
import {
  transcriptFixture,
  transcriptHarness,
  digest,
  part,
  type TranscriptHarness,
} from './transcript-fixture.ts';

const isInvalidView = (error: unknown) =>
  error instanceof TranscriptReadError && error.problem === 'invalid-view';

/** A running snapshot whose live part the host serves. */
function liveSnapshot(
  f: TranscriptHarness,
  text = 'live content',
  incarnation = digest('view incarnation'),
) {
  const source: Extract<ChatTranscriptSource, { kind: 'live' }> = {
    kind: 'live',
    target: f.target,
    submissionId: 'submission',
    taskId: 'generation',
    attempt: 0,
    incarnation,
  };
  const descriptor = part('m0.b0', text);
  const snapshot: ChatSnapshot = {
    ...f.snapshot,
    state: 'running',
    observationStatus: 'connected',
    run: {
      stop: { target: f.target, submissionId: source.submissionId, taskId: source.taskId },
      state: 'running',
      text: text.slice(0, 64),
      truncated: text.length > 64,
      transcript: { source, parts: [descriptor], nextCursor: null, thinking: 'none' },
    },
  };
  f.sources.set(JSON.stringify(source), { source, data: [text] });
  return { source, descriptor, snapshot };
}
async function publishLive(f: TranscriptHarness, text?: string, incarnation?: string) {
  const live = liveSnapshot(f, text, incarnation);
  await f.publish(live.snapshot);
  return live;
}

function captureView(live: Awaited<ReturnType<typeof publishLive>>, offset = -12) {
  return {
    anchor: { key: `live:${live.source.submissionId}`, offset },
    expanded: ['live-thought', 'live-tool'],
  } satisfies TranscriptView;
}
test('view input rejects anchors that name no row', async (t) => {
  const f = await transcriptHarness(t, 64);
  for (const key of ['live', 'entry:', 'message:e1', ' '])
    await assert.rejects(
      f.transcript.setView({ anchor: { key, offset: 0 }, expanded: [] }),
      isInvalidView,
      key,
    );
  await assert.rejects(
    f.transcript.setView({ anchor: { key: 'entry:e16', offset: Number.NaN }, expanded: [] }),
    isInvalidView,
  );
  assert.equal(f.state.view.anchor, null);
  await f.transcript.jumpToEntry('e16');
  await f.transcript.setView({
    anchor: { key: 'entry:e16', offset: -3 },
    expanded: ['durable'],
  });
  await f.reopen();
  await f.transcript.restoreView();
  assert.deepEqual(f.state.view, {
    anchor: { key: 'entry:e16', offset: -3 },
    expanded: ['durable'],
  });
  assert(f.state.entries.some((entry) => entry.id === 'e16'));
  await f.transcript.jumpToEntry('invented-row');
  assert(f.state.error, 'unrecognized durable IDs fail explicitly');
  assert.deepEqual(f.state.view, {
    anchor: { key: 'entry:e16', offset: -3 },
    expanded: ['durable'],
  });
});

test('view memory remains bounded, isolated, and independent of caller mutation', async () => {
  const { TranscriptViewMemory } = await import('@moonbase/application/chat');
  const f = transcriptFixture(1);
  const memory = new TranscriptViewMemory();
  const anchor = { key: 'live:submission', offset: -1 };
  memory.set('A', f.target, { anchor, expanded: ['live'] });
  anchor.offset = 99;
  assert.equal(memory.get('A', f.target).anchor!.offset, -1);
  assert(Object.isFrozen(memory.get('A', f.target).anchor));
  assert.equal(memory.get('B', f.target).anchor, null);
  for (let index = 0; index < 70; index++) {
    const target = { ...f.target, conversationId: 'conversation-' + index };
    memory.set('A', target, {
      anchor: { key: 'entry:e' + index, offset: 0 },
      expanded: Array.from({ length: 128 }, (_, id) => 'x'.repeat(240) + id),
    });
  }
  assert.equal(memory.get('A', { ...f.target, conversationId: 'conversation-0' }).anchor, null);
  assert.equal(
    memory.get('A', { ...f.target, conversationId: 'conversation-69' }).anchor!.key,
    'entry:e69',
  );
  memory.clear();
  assert.equal(memory.get('A', { ...f.target, conversationId: 'conversation-69' }).anchor, null);
});

for (const change of ['append', 'replace', 'retire', 'reconnect'] as const)
  test(`view memory survives ${change} without content reads or source proofs`, async (t) => {
    const f = await transcriptHarness(t, 64);
    const live = await publishLive(f);
    const view = captureView(live);
    await f.transcript.setView(view);
    // The chat closes, and its host moves on before it opens again.
    await f.close();
    if (change === 'retire') f.snapshot = { ...live.snapshot, run: null, state: 'idle' };
    else if (change === 'reconnect')
      f.snapshot = { ...live.snapshot, observationStatus: 'reconnecting' };
    else
      f.snapshot = liveSnapshot(
        f,
        change === 'append' ? 'live content appended' : 'changed text',
      ).snapshot;
    const calls = f.calls.length;
    await f.reopen();
    await f.transcript.restoreView();
    assert.deepEqual(f.state.view, view);
    assert(
      !f.calls
        .slice(calls)
        .some(
          (call) =>
            call.operation === 'getChatTranscriptContent' ||
            call.operation === 'getChatHistoryAround',
        ),
    );
    await f.transcript.jumpToEntry('e16');
    await publishLive(f, 'another update');
    assert.equal(f.state.view.anchor!.key, 'entry:e16');
  });

test('failed navigation and observation remain visible independently of view memory', async (t) => {
  const f = await transcriptHarness(t, 64);
  const view = captureView(await publishLive(f));
  await f.transcript.setView(view);
  f.handlers.set('getChatHistoryAround', async () => {
    throw new ApplicationError({ code: 'Unavailable', message: 'history unavailable' });
  });
  await f.transcript.showEarlier();
  assert.match(f.state.error!, /history unavailable/);
  await f.transcript.setView({ ...view, anchor: { ...view.anchor, offset: -2 } });
  assert.match(f.state.error!, /history unavailable/);
  await f.transcript.fail(
    new ApplicationError({ code: 'Unauthorized', message: 'authority lost' }),
  );
  assert.equal(f.state.observation, 'failed');
  assert.match(f.state.error!, /authority lost/);
});

test('view input rejects anchor fields beyond the row key and offset', async (t) => {
  const f = await transcriptHarness(t, 64);
  for (const extra of [{ entryId: 'e16' }, { partId: 'm0.b0' }])
    await assert.rejects(
      f.transcript.setView({
        anchor: { key: 'entry:e16', offset: -2, ...extra } as never,
        expanded: [],
      }),
      isInvalidView,
    );
});
