import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApplicationError } from '@moonbase/contracts/errors';
import { createMoonbaseApplication, type MoonbaseApplication } from '@moonbase/application';
import type { TranscriptView } from '@moonbase/application/chat';
import type { ChatSnapshot, ChatTranscriptSource } from '@moonbase/contracts/chat';
import { transcriptFixture, transcriptController, digest, part } from './transcript-fixture.ts';

function publishLive(
  f: ReturnType<typeof transcriptFixture>,
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
  f.publish(snapshot);
  return { source, descriptor, snapshot };
}
async function cleanupSettled(app: MoonbaseApplication) {
  if (!app.getSnapshot().cleanup.pending.length) return;
  await new Promise<void>((resolve) => {
    const off = app.subscribe(() => {
      if (!app.getSnapshot().cleanup.pending.length) {
        off();
        resolve();
      }
    });
  });
}

test('application restores the live row and expansions across panel and named-controller replacement, never restart', async () => {
  const a = transcriptFixture(64),
    b = transcriptFixture(64);
  publishLive(a);
  publishLive(b);
  const options = {
    chatTargets: [
      { id: 'A', label: 'A', acquire: async () => a.dependencies },
      { id: 'B', label: 'B', acquire: async () => b.dependencies },
    ],
  };
  const view: TranscriptView = {
    anchor: { key: 'live:submission', offset: -17.5 },
    expanded: ['thought', 'tool'],
  };
  const app = await createMoonbaseApplication(options);
  try {
    let chat = app.chat!;
    await chat.start();
    await chat.select(a.target);
    assert.equal(chat.backendId, 'A');
    chat.setTranscriptView(view);
    const raw = a.storage.value;
    assert(app.closeChat());
    await cleanupSettled(app);
    chat = (await app.openChat())!;
    await chat.start();
    assert.deepEqual(chat.getSnapshot().transcript.view, view);
    assert.equal(a.calls.filter((call) => call.operation === 'getChatHistoryAround').length, 0);
    chat = (await app.selectChatTarget('B'))!;
    await chat.start();
    await chat.select(b.target);
    assert.equal(chat.backendId, 'B');
    assert.equal(chat.getSnapshot().transcript.view.anchor, null, 'each backend has its own view');
    chat.setTranscriptView({ anchor: { key: 'entry:e40', offset: 0 }, expanded: [] });
    chat = (await app.selectChatTarget('A'))!;
    await chat.start();
    assert.deepEqual(chat.getSnapshot().transcript.view, view);
    assert.equal(a.storage.value, raw);
    assert(!raw!.includes('anchor') && !raw!.includes('expanded'));
  } finally {
    await app.dispose();
  }
  const restarted = await createMoonbaseApplication(options);
  try {
    await restarted.chat!.start();
    assert.equal(restarted.chat!.getSnapshot().selected!.conversationId, a.target.conversationId);
    assert.equal(restarted.chat!.getSnapshot().transcript.view.anchor, null);
    assert.deepEqual(restarted.chat!.getSnapshot().transcript.view.expanded, []);
    assert.equal(restarted.chat!.getSnapshot().transcript.atLatest, true);
  } finally {
    await restarted.dispose();
  }
});

function captureView(live: ReturnType<typeof publishLive>, offset = -12) {
  return {
    anchor: { key: `live:${live.source.submissionId}`, offset },
    expanded: ['live-thought', 'live-tool'],
  } satisfies TranscriptView;
}
test('view input rejects anchors that name no row', async (t) => {
  const f = await transcriptController(t, 64);
  for (const key of ['live', 'entry:', 'message:e1', ' '])
    assert.throws(
      () => f.controller.setTranscriptView({ anchor: { key, offset: 0 }, expanded: [] }),
      (error) => ApplicationError.is(error),
      key,
    );
  assert.throws(
    () =>
      f.controller.setTranscriptView({
        anchor: { key: 'entry:e16', offset: Number.NaN },
        expanded: [],
      }),
    ApplicationError.is,
  );
  assert.equal(f.controller.getSnapshot().transcript.view.anchor, null);
  await f.controller.jumpToEntry('e16');
  f.controller.setTranscriptView({
    anchor: { key: 'entry:e16', offset: -3 },
    expanded: ['durable'],
  });
  await f.controller.detach();
  await f.controller.start();
  assert.deepEqual(f.controller.getSnapshot().transcript.view, {
    anchor: { key: 'entry:e16', offset: -3 },
    expanded: ['durable'],
  });
  assert(f.controller.getSnapshot().transcript.entries.some((entry) => entry.id === 'e16'));
  await f.controller.jumpToEntry('invented-row');
  assert(f.controller.getSnapshot().transcript.error, 'unrecognized durable IDs fail explicitly');
  assert.deepEqual(f.controller.getSnapshot().transcript.view, {
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
    const f = await transcriptController(t, 64);
    const live = publishLive(f.fixture);
    const view = captureView(live);
    f.controller.setTranscriptView(view);
    await f.controller.detach();
    if (change === 'retire') f.fixture.publish({ ...live.snapshot, run: null, state: 'idle' });
    else if (change === 'reconnect')
      f.fixture.publish({ ...live.snapshot, observationStatus: 'reconnecting' });
    else publishLive(f.fixture, change === 'append' ? 'live content appended' : 'changed text');
    const calls = f.calls.length;
    await f.controller.start();
    assert.deepEqual(f.controller.getSnapshot().transcript.view, view);
    assert(
      !f.calls
        .slice(calls)
        .some(
          (call) =>
            call.operation === 'getChatTranscriptContent' ||
            call.operation === 'getChatHistoryAround',
        ),
    );
    await f.controller.jumpToEntry('e16');
    publishLive(f.fixture, 'another update');
    assert.equal(f.controller.getSnapshot().transcript.view.anchor!.key, 'entry:e16');
  });

test('failed navigation and observation remain visible independently of view memory', async (t) => {
  const f = await transcriptController(t, 64);
  const view = captureView(publishLive(f.fixture));
  f.controller.setTranscriptView(view);
  f.fixture.handlers.set('getChatHistoryAround', async () => {
    throw new ApplicationError({ code: 'Unavailable', message: 'history unavailable' });
  });
  await f.controller.showEarlier();
  assert.match(f.controller.getSnapshot().transcript.error!, /history unavailable/);
  f.controller.setTranscriptView({ ...view, anchor: { ...view.anchor, offset: -2 } });
  assert.match(f.controller.getSnapshot().transcript.error!, /history unavailable/);
  f.fixture.fail(new ApplicationError({ code: 'Unauthorized', message: 'authority lost' }));
  assert.equal(f.controller.getSnapshot().transcript.observation, 'failed');
  assert.match(f.controller.getSnapshot().transcript.error!, /authority lost/);
});

test('view input rejects anchor fields beyond the row key and offset', async (t) => {
  const f = await transcriptController(t, 64);
  for (const extra of [{ entryId: 'e16' }, { partId: 'm0.b0' }])
    assert.throws(
      () =>
        f.controller.setTranscriptView({
          anchor: { key: 'entry:e16', offset: -2, ...extra } as never,
          expanded: [],
        }),
      ApplicationError.is,
    );
});
