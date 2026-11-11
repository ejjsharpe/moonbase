import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatClient, ChatSnapshot, ChatTarget } from '@moonbase/contracts/chat';
import { ApplicationError } from '@moonbase/contracts/errors';
import { modelRoot } from './chat-model-fixture.ts';
import { tick, transcriptFixture } from './transcript-fixture.ts';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await tick();
  }
  assert(check());
}
const unavailable = () =>
  new ApplicationError({ code: 'Unavailable', message: 'Stream reconnect budget exhausted.' });
const mutations = ['sendChat', 'createChat', 'stopChat'];

/** A controller whose ChatClient records every watch, so tests can drive old and new watches. */
async function recoveryController(
  t: { after: (close: () => Promise<void>) => void },
  retry: number[],
  options: { local?: boolean; healthyMs?: number; throwOnWatch?: (count: number) => unknown } = {},
) {
  const { local = true, healthyMs = 60_000, throwOnWatch } = options;
  const fixture = transcriptFixture(4, local),
    root = modelRoot();
  t.after(() => root.close());
  const watches: {
    target: ChatTarget;
    receive: (snapshot: ChatSnapshot) => void;
    fail: (error: ApplicationError) => void;
    closed: boolean;
  }[] = [];
  let watchCalls = 0;
  const chat: ChatClient = {
    watchChatList: () => async () => {},
    command(operation, input, options) {
      const target = (input as { target?: ChatTarget }).target;
      if (operation === 'getChat' && target?.conversationId !== fixture.target.conversationId) {
        fixture.calls.push({ operation, input });
        const other = structuredClone(fixture.snapshot);
        return Promise.resolve({
          ...other,
          conversation: { ...other.conversation, target },
          entries: [],
          olderCursor: null,
          transcriptBoundary: null,
        } as never);
      }
      return fixture.chat.command(operation, input, options);
    },
    watch(input, receive, fail) {
      const thrown = throwOnWatch?.(++watchCalls);
      if (thrown) throw thrown;
      const watch = { target: input.target, receive, fail, closed: false };
      watches.push(watch);
      return async () => {
        watch.closed = true;
      };
    },
  };
  const controller = await root.make({
    ...fixture.dependencies,
    chat,
    transcriptWatchRetryMs: retry,
    transcriptWatchHealthyMs: healthyMs,
  });
  await controller.start();
  if (!local) await controller.connect();
  await controller.select(fixture.target);
  const watchesOf = (target: ChatTarget) =>
    watches.filter((watch) => watch.target.conversationId === target.conversationId);
  return { fixture, controller, watches, watchesOf };
}

test('a retryable stream failure re-watches the selected chat without resending, fencing the old watch', async (t) => {
  const { fixture, controller, watches } = await recoveryController(t, [5], { healthyMs: 10 });
  assert.equal(watches.length, 1);
  const snapshot = controller.getSnapshot().snapshot!;
  watches[0].fail(unavailable());
  let state = controller.getSnapshot();
  assert.equal(state.transcript.observation, 'reconnecting');
  assert.equal(state.error, null);
  assert.equal(state.snapshot?.observationStatus, 'reconnecting');
  await tick();
  assert.equal(watches[0].closed, true, 'the failed subscription closes before the backoff');
  assert.equal(watches.length, 1);

  await until(
    () => watches.length === 2 && controller.getSnapshot().transcript.observation === 'local',
  );
  assert.equal(watches[1].closed, false);
  assert.equal(fixture.calls.filter((call) => call.operation === 'getChat').length, 2);
  assert.equal(controller.getSnapshot().snapshot?.observationStatus, undefined);

  state = controller.getSnapshot();
  const late = { ...snapshot, conversation: { ...snapshot.conversation, title: 'Late' } };
  watches[0].receive(late);
  assert.equal(controller.getSnapshot(), state, 'the failed watch cannot deliver');
  const fresh = { ...snapshot, conversation: { ...snapshot.conversation, title: 'Fresh' } };
  watches[1].receive(fresh);
  assert.equal(controller.getSnapshot().snapshot?.conversation.title, 'Fresh');

  // A watch that stayed up for the healthy period after its first snapshot renews the cap.
  await delay(30);
  watches[1].fail(unavailable());
  await until(
    () => watches.length === 3 && controller.getSnapshot().transcript.observation === 'local',
  );
  assert.deepEqual(
    fixture.calls.filter((call) => mutations.includes(call.operation)),
    [],
    'recovery only reads',
  );
});

test('consecutive stream failures stop at the cap with a clear error and a manual retry', async (t) => {
  const { controller, watches } = await recoveryController(t, [1]);
  watches[0].fail(unavailable());
  await until(() => watches.length === 2);
  watches[1].fail(unavailable());
  let state = controller.getSnapshot();
  assert.equal(state.transcript.observation, 'failed');
  assert.match(state.error!, /Live updates stopped and could not reconnect/);
  assert.match(state.transcript.error!, /Refresh or reopen the conversation/);
  await delay(20);
  assert.equal(watches.length, 2, 'no re-watch after the cap');
  assert.equal(watches[1].closed, true, 'giving up releases the failed subscription');

  await controller.refresh();
  state = controller.getSnapshot();
  assert.equal(watches.length, 3);
  assert.equal(state.transcript.observation, 'local');

  // A failure that is not retryable stops at once.
  watches[2].fail(new ApplicationError({ code: 'Incompatible', message: 'Bad stream frame.' }));
  assert.equal(controller.getSnapshot().transcript.observation, 'failed');
  await delay(20);
  assert.equal(watches.length, 3);
});

test('a host that sends one snapshot per watch and then drops still reaches the cap', async (t) => {
  const { controller, watches } = await recoveryController(t, [1, 1]);
  const snapshot = controller.getSnapshot().snapshot!;
  for (let attempt = 0; attempt < 3; attempt++) {
    await until(() => watches.length === attempt + 1);
    watches[attempt].receive(snapshot);
    watches[attempt].fail(unavailable());
  }
  const state = controller.getSnapshot();
  assert.equal(state.transcript.observation, 'failed');
  assert.match(state.error!, /could not reconnect/);
  await delay(20);
  assert.equal(watches.length, 3);
});

test('a transcript that already failed is not re-watched after the stream drops', async (t) => {
  const { fixture, controller, watches } = await recoveryController(t, [1]);
  const snapshot = controller.getSnapshot().snapshot!;
  const other = { ...snapshot.conversation, target: { ...fixture.target, conversationId: 'x' } };
  watches[0].receive({ ...snapshot, conversation: other });
  assert.equal(controller.getSnapshot().transcript.observation, 'failed');
  const failed = controller.getSnapshot();
  watches[0].fail(unavailable());
  await delay(20);
  assert.equal(watches.length, 1);
  assert.equal(watches[0].closed, true);
  assert.equal(controller.getSnapshot().transcript.observation, 'failed');
  assert.equal(controller.getSnapshot().error, failed.error, 'the original failure stays');

  await controller.refresh();
  assert.equal(watches.length, 2);
  assert.equal(controller.getSnapshot().transcript.observation, 'local');
});

test('a re-watch that throws while subscribing counts as a failed attempt', async (t) => {
  // A failed watch acquisition stays observable through disposal, as for any watch.
  const cleanup: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const close of cleanup) await assert.rejects(close(), { code: 'Unavailable' });
  });
  const { controller, watches } = await recoveryController(
    { after: (close) => void cleanup.push(close) },
    [1, 1],
    { throwOnWatch: (count) => (count === 2 ? unavailable() : undefined) },
  );
  watches[0].fail(unavailable());
  await until(
    () => watches.length === 2 && controller.getSnapshot().transcript.observation === 'local',
  );
  assert.equal(controller.getSnapshot().error, null);
});

for (const action of ['close', 'switch', 'detach', 'dispose'] as const)
  test(`no re-watch after ${action} during the backoff`, async (t) => {
    const { fixture, controller, watchesOf } = await recoveryController(t, [10]);
    watchesOf(fixture.target)[0].fail(unavailable());
    assert.equal(controller.getSnapshot().transcript.observation, 'reconnecting');
    const other = { ...fixture.target, conversationId: 'other' };
    if (action === 'close') await controller.closeView();
    else if (action === 'switch') await controller.select(other);
    else if (action === 'detach') await controller.detach();
    else await controller.dispose();
    await delay(40);
    assert.equal(watchesOf(fixture.target).length, 1);
    if (action === 'switch') {
      assert.equal(watchesOf(other).length, 1);
      assert.equal(controller.getSnapshot().snapshot?.conversation.target.conversationId, 'other');
    }
  });

test('no re-watch after disconnect during the backoff', async (t) => {
  const { fixture, controller, watchesOf } = await recoveryController(t, [10], { local: false });
  watchesOf(fixture.target)[0].fail(unavailable());
  await controller.disconnect();
  await delay(40);
  assert.equal(watchesOf(fixture.target).length, 1);
  assert.equal(controller.getSnapshot().transcript.observation, 'inactive');
});
