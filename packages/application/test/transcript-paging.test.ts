import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatInput } from '@moonbase/contracts/chat';
import { ApplicationError } from '@moonbase/contracts/errors';
import { modelRoot } from './chat-model-fixture.ts';
import {
  digest,
  part,
  tick,
  transcriptController,
  transcriptFixture,
} from './transcript-fixture.ts';

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
    await controller.showEarlier();
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

test('legacy older paging rereads history evicted while following instead of skipping it', async (t) => {
  const f = transcriptFixture(2200),
    root = modelRoot();
  t.after(() => root.close());
  const cursors: string[] = [];
  f.handlers.set('getChatHost', async (_input, _signal, fallback) => ({
    ...(fallback() as object),
    features: [],
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
  const head = (end: number) => ({
    ...f.snapshot,
    entries: f.entries.slice(end - 32, end).reverse(),
    olderCursor: String(end - 32),
    transcriptBoundary: f.entries[end - 1].id,
  });
  f.publish(head(1200));
  const controller = await root.make(f.dependencies);
  await controller.start();
  await controller.select(f.target);
  for (let page = 0; page < 4; page++) await controller.showEarlier();
  assert.deepEqual(cursors, ['1168', '1136', '1104', '1072']);
  while (controller.getSnapshot().transcript.later) await controller.showLater();
  assert.equal(controller.getSnapshot().transcript.atLatest, true);
  // Following continuous snapshots past the record budget evicts the oldest records (e1040 on).
  for (let end = 1220; end <= 2120; end += 20) f.publish(head(end));
  assert.equal(controller.getSnapshot().transcript.entries[0].id, 'e1096');
  const seen = new Set<string>();
  for (let step = 0; step < 80; step++) {
    const state = controller.getSnapshot().transcript;
    assert.equal(state.error, null);
    state.entries.forEach((entry) => seen.add(entry.id));
    if (!state.earlier) break;
    await controller.showEarlier();
  }
  assert.equal(cursors[4], '1104', 'resume from the oldest cached checkpoint');
  assert.deepEqual(
    f.entries.slice(0, 2120).filter((entry) => !seen.has(entry.id)),
    [],
    'no evicted history is skipped',
  );
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
    // Select awaits the open that refresh performs once it has verified the host.
    const selecting = controller.select(f.target);
    await tick();
    assert.equal(controller.getSnapshot().snapshot, null);
    host.resolve();
    await selecting;
    assert.notEqual(controller.getSnapshot().snapshot, null);
    const transcript = controller.getSnapshot().transcript;
    assert.equal(controller.getSnapshot().ready, true);
    assert.deepEqual(transcript.capabilities, { transcript: 'available', find: 'available' });
    assert.equal(transcript.observation, 'streaming');
  } finally {
    host.resolve();
  }
});

test('a failed chat list does not prevent opening chats on the verified host', async (t) => {
  const f = transcriptFixture(64),
    root = modelRoot();
  t.after(() => root.close());
  f.handlers.set('listChats', async () => {
    throw new ApplicationError({ code: 'Unavailable', message: 'chat list unavailable' });
  });
  const controller = await root.make(f.dependencies);
  await controller.start();
  assert.match(controller.getSnapshot().error!, /chat list unavailable/);
  assert.equal(controller.getSnapshot().ready, true);
  await controller.select(f.target);
  assert.equal(controller.getSnapshot().transcript.capabilities.transcript, 'available');
  assert.notEqual(controller.getSnapshot().snapshot, null);
  // Refresh reopens the saved selection even though listing still fails.
  await controller.detach();
  assert.equal(controller.getSnapshot().snapshot, null);
  await controller.start();
  assert.equal(controller.getSnapshot().transcript.capabilities.transcript, 'available');
  assert.notEqual(controller.getSnapshot().snapshot, null);
  assert.match(controller.getSnapshot().error!, /chat list unavailable/);
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
    const closeGraceMs = 50;
    const f = await transcriptController(t, 1, true, { transcriptCloseGraceMs: closeGraceMs });
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
    assert(performance.now() - started >= closeGraceMs - 5);
  });

test('part and manifest failures stay on their own state, apart from the history error', async (t) => {
  const f = await transcriptController(t, 640);
  const source = f.entries[630].transcript!.source;
  const selection = { partId: 'm0.b0', bytes: 9, revision: digest('same text') };
  let contentFails = true;
  f.handlers.set('getChatTranscriptContent', async (_input, _signal, fallback) => {
    if (contentFails)
      throw new ApplicationError({ code: 'Unavailable', message: 'content unavailable' });
    return fallback();
  });
  await f.controller.loadTranscriptPart(source, selection);
  await f.controller.loadTranscriptManifest(source);
  let state = f.controller.getSnapshot().transcript;
  assert.equal(state.error, null, 'a content failure does not block history paging');
  assert.deepEqual(
    state.content.map(({ status, error }) => ({ status, error })),
    [{ status: 'error', error: 'content unavailable' }],
  );
  assert.equal(state.manifest?.status, 'error');
  assert.equal(state.manifest?.error, 'content unavailable');

  // A failed page read keeps its error while content reads start and settle, so nothing
  // retries it until the reader does.
  let historyFails = true;
  f.handlers.set('getChatHistoryAround', async (_input, _signal, fallback) => {
    if (historyFails)
      throw new ApplicationError({ code: 'Unavailable', message: 'history unavailable' });
    return fallback();
  });
  await f.controller.showEarlier();
  assert.match(f.controller.getSnapshot().transcript.error!, /history unavailable/);
  contentFails = false;
  await f.controller.loadTranscriptPart(source, selection, true);
  await f.controller.loadTranscriptManifest(source, true);
  state = f.controller.getSnapshot().transcript;
  assert.match(state.error!, /history unavailable/);
  assert.equal(state.content[0]?.status, 'complete');
  historyFails = false;
  await f.controller.showEarlier();
  assert.equal(f.controller.getSnapshot().transcript.error, null);
});
