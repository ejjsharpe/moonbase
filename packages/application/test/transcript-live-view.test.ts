import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApplicationError } from '@moonbase/contracts/errors';
import { createMoonbaseApplication, type MoonbaseApplication } from '@moonbase/application';
import type {
  TranscriptView,
  TranscriptLiveAnchor,
  ChatController,
} from '@moonbase/application/chat';
import type { ChatInput, ChatSnapshot, ChatTranscriptSource } from '@moonbase/contracts/chat';
import {
  transcriptFixture,
  transcriptController,
  digest,
  part,
  tick,
} from './transcript-fixture.ts';

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
      tools: [],
      transcript: { source, parts: [descriptor], nextCursor: null, thinking: 'pending' },
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

test('application restores the exact live part and expansions across panel and named-controller replacement, never restart', async () => {
  const a = transcriptFixture(64),
    b = transcriptFixture(64);
  const live = publishLive(a);
  publishLive(b);
  const options = {
    chatTargets: [
      { id: 'A', label: 'A', acquire: async () => a.dependencies },
      { id: 'B', label: 'B', acquire: async () => b.dependencies },
    ],
  };
  const view: TranscriptView = {
    anchor: {
      backendId: 'A',
      source: live.source,
      partId: live.descriptor.partId,
      bytes: live.descriptor.bytes,
      revision: live.descriptor.revision,
      offset: -17.5,
    },
    expanded: ['thought', 'tool'],
  };
  const app = await createMoonbaseApplication(options);
  try {
    let chat = app.chat!;
    await chat.start();
    await chat.select(a.target);
    assert.equal(chat.backendId, 'A');
    chat.setTranscriptView(view);
    assert.equal(chat.getSnapshot().transcript.viewStatus, 'ready');
    const raw = a.storage.value;
    assert(app.closeChat());
    await cleanupSettled(app);
    chat = (await app.openChat())!;
    await chat.start();
    assert.deepEqual(chat.getSnapshot().transcript.view, view);
    assert.equal(chat.getSnapshot().transcript.viewStatus, 'ready');
    assert.equal(a.calls.filter((call) => call.operation === 'getChatHistoryAround').length, 0);
    chat = (await app.selectChatTarget('B'))!;
    await chat.start();
    await chat.select(b.target);
    assert.equal(chat.backendId, 'B');
    assert.equal(chat.getSnapshot().transcript.view.anchor, null);
    assert.throws(
      () => chat.setTranscriptView(view),
      (error) => ApplicationError.is(error),
    );
    assert.deepEqual(chat.getSnapshot().transcript.view.expanded, []);
    chat = (await app.selectChatTarget('A'))!;
    await chat.start();
    assert.deepEqual(chat.getSnapshot().transcript.view, view);
    assert.equal(chat.getSnapshot().transcript.viewStatus, 'ready');
    assert.equal(a.storage.value, raw);
    assert(!raw!.includes('anchor') && !raw!.includes('incarnation') && !raw!.includes('expanded'));
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

function captureView(
  controller: ChatController,
  live: ReturnType<typeof publishLive>,
  offset = -12,
): TranscriptView & { anchor: TranscriptLiveAnchor } {
  return {
    anchor: {
      backendId: controller.backendId,
      source: live.source,
      partId: live.descriptor.partId,
      bytes: live.descriptor.bytes,
      revision: live.descriptor.revision,
      offset,
    },
    expanded: ['live-thought', 'live-tool'],
  };
}
async function waitView(controller: ChatController) {
  if (controller.getSnapshot().transcript.viewStatus !== 'pending') return;
  await new Promise<void>((resolve) => {
    const off = controller.subscribe(() => {
      if (controller.getSnapshot().transcript.viewStatus !== 'pending') {
        off();
        resolve();
      }
    });
  });
}
function runAfterMicrotasks(delay: number, work: () => void) {
  let turn = 0;
  const advance = () => {
    if (turn++ < delay) queueMicrotask(advance);
    else work();
  };
  queueMicrotask(advance);
}

test('live restoration waits for a fresh coherent observation and proves a retained prefix after append', async (t) => {
  const f = await transcriptController(t, 64),
    live = publishLive(f.fixture);
  const view = captureView(f.controller, live);
  f.controller.setTranscriptView(view);
  await f.controller.detach();
  const next = publishLive(f.fixture, 'live content appended');
  f.fixture.publish({ ...next.snapshot, observationStatus: 'reconnecting' });
  await f.controller.start();
  assert.equal(f.controller.getSnapshot().transcript.viewStatus, 'pending');
  const before = f.calls.length;
  f.fixture.publish(next.snapshot);
  await waitView(f.controller);
  assert.equal(f.controller.getSnapshot().transcript.viewStatus, 'ready');
  assert.deepEqual(f.controller.getSnapshot().transcript.view, view);
  const proof = f.calls
    .slice(before)
    .filter((call) => call.operation === 'getChatTranscriptContent');
  assert.equal(proof.length, 1);
  assert.deepEqual((proof[0].input as { selection: unknown }).selection, {
    partId: view.anchor.partId,
    bytes: view.anchor.bytes,
    revision: view.anchor.revision,
  });
  const ready = f.controller.getSnapshot(),
    requests = f.calls.length;
  for (let index = 0; index < 8; index++) f.fixture.publish(structuredClone(next.snapshot));
  assert.equal(f.controller.getSnapshot(), ready);
  assert.equal(f.calls.length, requests, 'equivalent DTOs do not repeat anchor proofs');
  f.controller.setTranscriptView({
    ...view,
    anchor: { ...view.anchor, offset: -7 },
    expanded: ['another-expansion'],
  });
  assert.equal(f.controller.getSnapshot().transcript.viewStatus, 'ready');
  assert.equal(f.calls.length, requests, 'viewport/expansion changes reuse the same prefix proof');
  assert(!f.calls.some((call) => call.operation === 'getChatHistoryAround'));
});

test('finite appends across proof cleanup and publication never strand live restoration', async () => {
  const outcomes = { ready: 0, 'source-changed': 0 };
  for (let delay = 0; delay < 100; delay++) {
    let close!: () => Promise<void>;
    const f = await transcriptController({ after: (cleanup) => (close = cleanup) }, 64);
    try {
      const live = publishLive(f.fixture, 'captured');
      const view = captureView(f.controller, live);
      f.controller.setTranscriptView(view);
      await f.controller.detach();
      publishLive(f.fixture, 'captured first append');
      let scheduled = false;
      f.handlers.set('getChatTranscriptContent', async (_raw, _signal, fallback) => {
        const reply = fallback();
        if (!scheduled) {
          scheduled = true;
          runAfterMicrotasks(delay, () =>
            publishLive(f.fixture, 'captured first append second append'),
          );
        }
        return reply;
      });
      await f.controller.start();
      for (let turn = 0; turn < 10; turn++) await tick();
      const state = f.controller.getSnapshot().transcript;
      assert.notEqual(state.viewStatus, 'pending', `stranded after microtask ${delay}`);
      assert(state.viewStatus === 'ready' || state.viewStatus === 'source-changed');
      outcomes[state.viewStatus]++;
      assert.equal(state.loading, false);
      assert.equal(state.error, null);
      assert.deepEqual(state.view, view);
      const reads = f.calls.filter((call) => call.operation === 'getChatTranscriptContent');
      assert(reads.length <= 4, 'one data read and at most three superseded prefix proofs');
      for (const read of reads) {
        const input = read.input as ChatInput<'getChatTranscriptContent'>;
        assert.deepEqual(input.source, view.anchor.source);
        assert.deepEqual(input.selection, {
          partId: view.anchor.partId,
          bytes: view.anchor.bytes,
          revision: view.anchor.revision,
        });
        assert.equal(input.cursor, undefined);
      }
      if (state.viewStatus === 'source-changed') {
        assert.match(state.viewError!, /proof|evidence/);
        const snapshot = f.controller.getSnapshot();
        f.fixture.publish(structuredClone(f.fixture.snapshot));
        await tick();
        assert.equal(f.controller.getSnapshot(), snapshot, 'no unbounded automatic proof retry');
        assert.equal(
          f.calls.filter((call) => call.operation === 'getChatTranscriptContent').length,
          reads.length,
        );
        f.controller.setTranscriptView(view);
        await waitView(f.controller);
        assert.equal(f.controller.getSnapshot().transcript.viewStatus, 'ready');
      } else assert.equal(state.viewError, null);
    } finally {
      await close();
    }
  }
  assert(outcomes.ready > 0);
  assert(outcomes['source-changed'] > 0, 'the sweep reaches the final evidence fence');
});

for (const change of ['terminal', 'selection'] as const)
  test(`proof cleanup cannot overwrite ${change} supersession at final publication`, async () => {
    for (let delay = 10; delay < 25; delay++) {
      let close!: () => Promise<void>;
      const f = await transcriptController({ after: (cleanup) => (close = cleanup) }, 64);
      try {
        const view = captureView(f.controller, publishLive(f.fixture, 'captured'));
        f.controller.setTranscriptView(view);
        await f.controller.detach();
        const appended = publishLive(f.fixture, 'captured first append');
        const replacement = captureView(f.controller, appended, -29);
        replacement.expanded = ['replacement expansion'];
        let scheduled = false;
        f.handlers.set('getChatTranscriptContent', async (_raw, _signal, fallback) => {
          const reply = fallback();
          if (!scheduled) {
            scheduled = true;
            runAfterMicrotasks(delay, () => {
              if (change === 'terminal')
                f.fixture.fail(
                  new ApplicationError({
                    code: 'Unauthorized',
                    message: 'authority lost in cleanup',
                  }),
                );
              else f.controller.setTranscriptView(replacement);
            });
          }
          return reply;
        });
        await f.controller.start();
        for (let turn = 0; turn < 10; turn++) await tick();
        const current = f.controller.getSnapshot();
        assert.equal(current.transcript.loading, false);
        if (change === 'terminal') {
          assert.equal(current.transcript.observation, 'failed');
          assert.equal(current.transcript.viewStatus, 'source-changed');
          assert.match(current.transcript.viewError!, /authority lost in cleanup/);
          assert.match(current.error!, /^Unauthorized:/);
          assert.deepEqual(current.transcript.view, view);
        } else {
          assert.equal(current.transcript.viewStatus, 'ready');
          assert.equal(current.transcript.viewError, null);
          assert.deepEqual(current.transcript.view, replacement);
        }
        await tick();
        assert.equal(f.controller.getSnapshot(), current);
      } finally {
        await close();
      }
    }
  });

test('cancelled anchor proof retains actual IO and independent watch cleanup failure', async () => {
  const f = transcriptFixture(64);
  const watch = f.chat.watch;
  f.chat.watch = (...args) => {
    const close = watch(...args);
    return async () => {
      await close();
      throw new ApplicationError({ code: 'Unavailable', message: 'anchor watch cleanup failed' });
    };
  };
  const app = await createMoonbaseApplication({ chat: async () => f.dependencies });
  const entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<void>();
  try {
    const chat = app.chat!;
    await chat.start();
    await chat.select(f.target);
    chat.setTranscriptView(captureView(chat, publishLive(f, 'captured')));
    f.handlers.set('getChatTranscriptContent', async (_raw, _signal, fallback) => {
      const reply = fallback();
      entered.resolve();
      await held.promise;
      return reply;
    });
    publishLive(f, 'captured append');
    await entered.promise;
    const disposal = app.dispose();
    const rejected = assert.rejects(disposal, /anchor watch cleanup failed/);
    await tick();
    assert.equal(app.getSnapshot().phase, 'disposing');
    assert(f.calls.find((call) => call.operation === 'getChatTranscriptContent')!.signal!.aborted);
    const current = chat.getSnapshot();
    held.resolve();
    await rejected;
    assert.equal(chat.getSnapshot(), current, 'cancelled proof cannot publish a late failure');
    assert.equal(app.getSnapshot().phase, 'failed');
    assert(
      app
        .getSnapshot()
        .cleanup.errors.some((error) => error.includes('anchor watch cleanup failed')),
    );
  } finally {
    held.resolve();
    await app.dispose().catch(() => {});
  }
});

for (const changed of [
  'incarnation',
  'submission',
  'task',
  'attempt',
  'finalized',
  'missing-part',
  'replaced-prefix',
] as const)
  test(`live view restoration rejects ${changed} and recovers only through explicit latest`, async (t) => {
    const f = await transcriptController(t, 64),
      live = publishLive(f.fixture);
    const view = captureView(f.controller, live);
    f.controller.setTranscriptView(view);
    await f.controller.detach();
    const next = publishLive(
      f.fixture,
      changed === 'replaced-prefix' ? 'REPLACED content' : 'live content',
    );
    if (changed === 'incarnation') next.source.incarnation = digest('another incarnation');
    if (changed === 'submission') {
      next.source.submissionId = 'another-submission';
      next.snapshot.run!.stop.submissionId = next.source.submissionId;
    }
    if (changed === 'task') {
      next.source.taskId = 'another-task';
      next.snapshot.run!.stop.taskId = next.source.taskId;
    }
    if (changed === 'attempt') next.source.attempt++;
    if (changed === 'finalized') {
      next.snapshot.run = null;
      next.snapshot.state = 'idle';
    }
    if (changed === 'missing-part') next.snapshot.run!.transcript!.parts = [];
    f.fixture.publish(next.snapshot);
    await f.controller.start();
    await waitView(f.controller);
    const state = f.controller.getSnapshot().transcript;
    assert.equal(state.viewStatus, changed === 'missing-part' ? 'unavailable' : 'source-changed');
    assert(state.viewError);
    assert.deepEqual(state.view, view);
    assert(!f.calls.some((call) => call.operation === 'getChatHistoryAround'));
    await f.controller.jumpToLatest();
    assert.equal(f.controller.getSnapshot().transcript.viewStatus, 'ready');
    assert.equal(f.controller.getSnapshot().transcript.viewError, null);
    assert.equal(f.controller.getSnapshot().transcript.view.anchor, null);
    assert.deepEqual(f.controller.getSnapshot().transcript.view.expanded, []);
  });

for (const wrong of [
  'backend',
  'host',
  'store',
  'actor',
  'conversation',
  'incarnation',
  'attempt',
] as const)
  test(`live anchor input rejects the wrong ${wrong} before changing memory`, async (t) => {
    const f = await transcriptController(t, 64),
      live = publishLive(f.fixture);
    const view = captureView(f.controller, live);
    f.controller.setTranscriptView(view);
    const invalid = structuredClone(view);
    if (wrong === 'backend') invalid.anchor.backendId = 'another-backend';
    if (wrong === 'host') invalid.anchor.source.target.host.hostId = 'another-host';
    if (wrong === 'store') invalid.anchor.source.target.host.storeId = 'another-store';
    if (wrong === 'actor') invalid.anchor.source.target.actorId = 'another-actor';
    if (wrong === 'conversation')
      invalid.anchor.source.target.conversationId = 'another-conversation';
    if (wrong === 'incarnation') invalid.anchor.source.incarnation = digest('wrong incarnation');
    if (wrong === 'attempt') invalid.anchor.source.attempt++;
    const current = f.controller.getSnapshot(),
      reads = f.calls.length;
    assert.throws(
      () => f.controller.setTranscriptView(invalid),
      (error) => ApplicationError.is(error),
    );
    assert.equal(f.controller.getSnapshot(), current);
    assert.equal(f.calls.length, reads);
    await f.controller.detach();
    await f.controller.start();
    assert.deepEqual(f.controller.getSnapshot().transcript.view, view);
  });

test('synthetic durable anchors are rejected and never dispatched as around-entry reads', async (t) => {
  const f = await transcriptController(t, 64);
  assert.throws(
    () => f.controller.setTranscriptView({ anchor: { entryId: 'live', offset: 0 }, expanded: [] }),
    (error) => ApplicationError.is(error),
  );
  await f.controller.jumpToEntry('live');
  assert.match(f.controller.getSnapshot().transcript.error!, /exact live-part/);
  assert(!f.calls.some((call) => call.operation === 'getChatHistoryAround'));
  await f.controller.jumpToEntry('e16');
  f.controller.setTranscriptView({
    anchor: { entryId: 'e16', partId: 'm0.b0', offset: -3 },
    expanded: ['durable'],
  });
  await f.controller.detach();
  await f.controller.start();
  assert.deepEqual(f.controller.getSnapshot().transcript.view, {
    anchor: { entryId: 'e16', partId: 'm0.b0', offset: -3 },
    expanded: ['durable'],
  });
  await f.controller.jumpToEntry('invented-synthetic-row');
  assert(f.controller.getSnapshot().transcript.error, 'unrecognized durable IDs fail explicitly');
  assert.deepEqual(f.controller.getSnapshot().transcript.view, {
    anchor: { entryId: 'e16', partId: 'm0.b0', offset: -3 },
    expanded: ['durable'],
  });
});

test('a live part outside the initial manifest preview restores through a bounded exact-part proof', async (t) => {
  const f = await transcriptController(t, 64),
    live = publishLive(f.fixture);
  const data = Array.from({ length: 40 }, (_, index) => 'part-' + index);
  f.fixture.sources.set(JSON.stringify(live.source), { source: live.source, data });
  live.snapshot.run!.transcript!.parts = data
    .slice(0, 4)
    .map((value, index) => part('m0.b' + index, value));
  live.snapshot.run!.transcript!.nextCursor = '4';
  f.fixture.publish(live.snapshot);
  const selected = part('m0.b35', data[35]);
  const view: TranscriptView = {
    anchor: {
      backendId: f.controller.backendId,
      source: live.source,
      partId: selected.partId,
      bytes: selected.bytes,
      revision: selected.revision,
      offset: -8,
    },
    expanded: ['deep-tool'],
  };
  f.controller.setTranscriptView(view);
  await waitView(f.controller);
  assert.equal(f.controller.getSnapshot().transcript.viewStatus, 'ready');
  await f.controller.detach();
  const requests = f.calls.length;
  await f.controller.start();
  await waitView(f.controller);
  assert.deepEqual(f.controller.getSnapshot().transcript.view, view);
  assert.equal(f.controller.getSnapshot().transcript.viewStatus, 'ready');
  const reads = f.calls
    .slice(requests)
    .filter((call) => call.operation === 'getChatTranscriptContent');
  assert.equal(reads.length, 1);
  assert.equal((reads[0].input as { selection: { partId: string } }).selection.partId, 'm0.b35');
  assert(!f.calls.some((call) => call.operation === 'getChatHistoryAround'));
});

test('held restoration proof cannot restore a retired live part or publish late cleanup into the replacement', async (t) => {
  const f = await transcriptController(t, 64),
    live = publishLive(f.fixture);
  f.controller.setTranscriptView(captureView(f.controller, live));
  await f.controller.detach();
  publishLive(f.fixture, 'live content appended');
  const entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<void>();
  f.handlers.set('getChatTranscriptContent', async (_raw, _signal, fallback) => {
    const reply = fallback();
    entered.resolve();
    await held.promise;
    return reply;
  });
  try {
    const restoring = f.controller.start();
    await entered.promise;
    publishLive(f.fixture, 'next source', digest('replacement incarnation'));
    await restoring;
    const changed = f.controller.getSnapshot();
    assert.equal(changed.transcript.viewStatus, 'source-changed');
    assert(
      f.calls.filter((call) => call.operation === 'getChatTranscriptContent').at(-1)!.signal!
        .aborted,
    );
    held.resolve();
    await tick();
    assert.equal(f.controller.getSnapshot(), changed);
    assert(!f.calls.some((call) => call.operation === 'getChatHistoryAround'));
  } finally {
    held.resolve();
  }
});

test('history navigation supersedes a held live-anchor proof without late anchor or expansion updates', async (t) => {
  const f = await transcriptController(t, 64),
    live = publishLive(f.fixture);
  f.controller.setTranscriptView(captureView(f.controller, live));
  const entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<void>();
  f.handlers.set('getChatTranscriptContent', async (_raw, _signal, fallback) => {
    const reply = fallback();
    entered.resolve();
    await held.promise;
    return reply;
  });
  try {
    publishLive(f.fixture, 'live content appended');
    await entered.promise;
    await f.controller.older();
    const current = f.controller.getSnapshot();
    assert.equal(current.transcript.view.anchor!.source, undefined);
    assert.equal(current.transcript.viewStatus, 'ready');
    assert.equal(current.transcript.viewError, null);
    assert.deepEqual(current.transcript.view.expanded, []);
    assert(current.transcript.retained.summaries <= 256);
    assert(current.transcript.retained.summaryBytes <= 2 * 1024 * 1024);
    held.resolve();
    await tick();
    assert.equal(f.controller.getSnapshot(), current);
  } finally {
    held.resolve();
  }
});

test('failed live-anchor proof remains visible and retries only on explicit recapture', async (t) => {
  const f = await transcriptController(t, 64),
    live = publishLive(f.fixture);
  const view = captureView(f.controller, live);
  f.controller.setTranscriptView(view);
  await f.controller.detach();
  const appended = publishLive(f.fixture, 'live content appended');
  f.handlers.set('getChatTranscriptContent', async () => {
    throw new ApplicationError({ code: 'Unavailable', message: 'anchor proof unavailable' });
  });
  await f.controller.start();
  assert.equal(f.controller.getSnapshot().transcript.viewStatus, 'unavailable');
  assert.match(f.controller.getSnapshot().transcript.viewError!, /anchor proof unavailable/);
  const requests = f.calls.length;
  for (let index = 0; index < 8; index++) f.fixture.publish(structuredClone(appended.snapshot));
  assert.equal(f.calls.length, requests, 'progress does not silently retry failed support');
  f.handlers.delete('getChatTranscriptContent');
  f.controller.setTranscriptView(view);
  await waitView(f.controller);
  assert.equal(f.controller.getSnapshot().transcript.viewStatus, 'ready');
  assert.equal(f.controller.getSnapshot().transcript.viewError, null);
  assert.deepEqual(f.controller.getSnapshot().transcript.view, view);
  f.fixture.fail(new ApplicationError({ code: 'Unauthorized', message: 'live view access lost' }));
  const failed = f.controller.getSnapshot();
  assert.equal(failed.transcript.observation, 'failed');
  assert.equal(failed.transcript.viewStatus, 'source-changed');
  assert.match(failed.transcript.viewError!, /live view access lost/);
  assert.match(failed.error!, /Unauthorized/);
  assert.deepEqual(failed.transcript.view, view);
});

test('held live-anchor proof leaves drafting and exact Stop independent; disposal awaits actual settlement', async (t) => {
  const f = await transcriptController(t, 64),
    live = publishLive(f.fixture);
  f.controller.setTranscriptView(captureView(f.controller, live));
  await f.controller.detach();
  const appended = publishLive(f.fixture, 'live content appended');
  const entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<void>();
  f.handlers.set('getChatTranscriptContent', async (_raw, _signal, fallback) => {
    const reply = fallback();
    entered.resolve();
    await held.promise;
    return reply;
  });
  try {
    const restoring = f.controller.start();
    await entered.promise;
    f.controller.setDraft('draft while restoring');
    assert.equal(f.controller.getSnapshot().draft, 'draft while restoring');
    await f.controller.stop();
    assert.deepEqual(
      (f.calls.find((call) => call.operation === 'stopChat')!.input as ChatInput<'stopChat'>).stop,
      appended.snapshot.run!.stop,
    );
    const detaching = f.controller.detach();
    await restoring;
    const read = f.calls.find((call) => call.operation === 'getChatTranscriptContent')!;
    assert(read.signal!.aborted);
    let disposed = false;
    const closing = f.controller.dispose().then(() => (disposed = true));
    await tick();
    assert.equal(disposed, false);
    const detached = f.controller.getSnapshot();
    held.resolve();
    await Promise.all([detaching, closing]);
    assert.equal(f.controller.getSnapshot(), detached);
  } finally {
    held.resolve();
  }
});

test('live view memory remains bounded, isolated, and independent of caller mutation', async () => {
  const { TranscriptViewMemory } = await import('@moonbase/application/chat');
  const f = transcriptFixture(1),
    live = publishLive(f);
  const memory = new TranscriptViewMemory();
  const anchor: TranscriptLiveAnchor = {
    backendId: 'A',
    source: live.source,
    partId: live.descriptor.partId,
    bytes: live.descriptor.bytes,
    revision: live.descriptor.revision,
    offset: -1,
  };
  memory.set('A', f.target, { anchor, expanded: ['live'] });
  anchor.source.incarnation = digest('mutated by caller');
  assert.notEqual(memory.get('A', f.target).anchor!.source!.incarnation, anchor.source.incarnation);
  assert.equal(memory.get('B', f.target).anchor, null);
  for (let index = 0; index < 70; index++) {
    const target = { ...f.target, conversationId: 'conversation-' + index };
    const source = { ...live.source, target };
    memory.set('A', target, {
      anchor: { ...anchor, source },
      expanded: Array.from({ length: 128 }, (_, id) => 'x'.repeat(240) + id),
    });
  }
  assert.equal(memory.get('A', { ...f.target, conversationId: 'conversation-0' }).anchor, null);
  assert(memory.get('A', { ...f.target, conversationId: 'conversation-69' }).anchor!.source);
  assert.throws(() =>
    memory.set('A', f.target, { anchor: { entryId: 'live', offset: 0 }, expanded: [] }),
  );
  memory.clear();
  assert.equal(memory.get('A', { ...f.target, conversationId: 'conversation-69' }).anchor, null);
});
