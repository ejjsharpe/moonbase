import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transcriptLimits } from '@moonbase/application/chat';
import type { ChatInput } from '@moonbase/contracts/chat';
import { modelRoot } from './chat-model-fixture.ts';
import { part, tick, transcriptController, transcriptFixture } from './transcript-fixture.ts';

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await tick();
  assert(check());
}

test('legacy older paging keeps its furthest-back cursor through later snapshots', async (t) => {
  const f = transcriptFixture(200),
    root = modelRoot();
  t.after(() => root.close());
  const cursors: string[] = [];
  f.handlers.set('getChatHost', async (_input, _signal, fallback) => ({
    ...(fallback() as object),
    features: ['chat-stream-v1'],
  }));
  f.handlers.set('getChatHistory', async (raw) => {
    const { cursor } = raw as ChatInput<'getChatHistory'>;
    cursors.push(cursor);
    const end = Number(cursor),
      start = Math.max(0, end - 32);
    return {
      entries: f.entries.slice(start, end).reverse(),
      olderCursor: start ? String(start) : null,
    };
  });
  const controller = await root.make(f.dependencies);
  await controller.start();
  await controller.select(f.target);
  assert.equal(controller.getSnapshot().transcript.capabilities.transcript, 'legacy');
  for (let page = 0; page < 3; page++) {
    await controller.older();
    // Any watch update (here a running state) must not rewind the paging position.
    f.publish({ ...f.snapshot, state: page % 2 ? 'idle' : 'running' });
  }
  assert.deepEqual(cursors, ['168', '136', '104']);
  const state = controller.getSnapshot().transcript;
  assert.equal(state.error, null);
  assert.equal(state.entries.length, 128);
  assert.equal(state.entries[0].id, 'e72');
  assert.equal(state.earlier, true);
});

test('cached paging remembers the displayed edge row, not an off-screen cached row', async (t) => {
  const f = await transcriptController(t, 640);
  for (let i = 0; i < 100 && f.controller.getSnapshot().transcript.earlier; i++)
    await f.controller.older();
  for (let i = 0; i < 3; i++) {
    await f.controller.later();
    const state = f.controller.getSnapshot().transcript;
    assert.equal(state.view.anchor?.entryId, state.entries.at(-1)!.id);
  }
  await f.controller.older();
  const state = f.controller.getSnapshot().transcript;
  assert.notEqual(state.entries[0].id, 'e0', 'the window is inside the cached history');
  assert.equal(state.view.anchor?.entryId, state.entries[0].id);
});

test('a chat opened before the host features are verified opens with those features', async (t) => {
  const f = transcriptFixture(64, false),
    root = modelRoot();
  t.after(() => root.close());
  const host = Promise.withResolvers<void>();
  f.handlers.set('getChatHost', async (_input, _signal, fallback) => {
    await host.promise;
    return fallback();
  });
  try {
    const controller = await root.make(f.dependencies);
    await controller.start();
    await controller.connect();
    // A repeated connection event while the host read is held is not readiness.
    await f.dependencies.connection!.command('getConnection', {});
    assert.equal(controller.getSnapshot().connection?.state, 'connected');
    assert.equal(controller.getSnapshot().ready, false);
    await controller.select(f.target);
    assert.equal(controller.getSnapshot().snapshot, null);
    host.resolve();
    await until(() => controller.getSnapshot().snapshot !== null);
    const transcript = controller.getSnapshot().transcript;
    assert.equal(controller.getSnapshot().ready, true);
    assert.deepEqual(transcript.capabilities, { transcript: 'available', find: 'available' });
    assert.equal(transcript.observation, 'streaming');
  } finally {
    host.resolve();
  }
});

test('every accepted snapshot change notifies subscribers once', async (t) => {
  const f = await transcriptController(t, 40);
  let notifications = 0;
  const off = f.controller.subscribe(() => notifications++);
  try {
    f.publish({ ...f.snapshot, state: 'running' });
    assert.equal(notifications, 1);
    assert.equal(f.controller.getSnapshot().snapshot!.state, 'running');
    const entry = {
      ...f.entries[0],
      id: 'appended',
      transcript: {
        ...f.entries[0].transcript!,
        source: { kind: 'entry' as const, target: f.target, entryId: 'appended' },
        parts: [part('m0.b0', 'appended')],
      },
    };
    f.publish({ ...f.fixture.snapshot, entries: [entry, ...f.fixture.snapshot.entries] });
    assert.equal(notifications, 2);
    assert.equal(f.controller.getSnapshot().transcript.entries.at(-1)!.id, 'appended');
    f.controller.openFind();
    assert.equal(notifications, 3);
    const before = f.controller.getSnapshot();
    f.publish(structuredClone(f.fixture.snapshot));
    assert.equal(notifications, 3);
    assert.equal(f.controller.getSnapshot(), before);
  } finally {
    off();
  }
});

for (const close of ['closeView', 'detach', 'dispose'] as const)
  test(`${close} releases after a bounded grace when a ChatClient read ignores cancellation`, async (t) => {
    const f = await transcriptController(t, 1);
    const entered = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    f.handlers.set('getChatTranscriptContent', (_input, abort) => {
      signal = abort;
      entered.resolve();
      return new Promise<never>(() => {});
    });
    const source = f.entries[0].transcript!.source;
    void f.controller.loadTranscriptManifest(source);
    await entered.promise;
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      f.controller[close](),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Error(`${close} waited for an abandoned read`)), 10000);
      }),
    ]).finally(() => clearTimeout(timer));
    assert(signal?.aborted);
    assert(performance.now() - started >= transcriptLimits.closeGraceMs - 50);
  });
