import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IncompatibleHostError } from '@moonbase/contracts/host-errors';
import {
  chatFixture,
  snapshot,
  target,
  turn,
  unavailable,
  type ChatFixture,
} from '../chat-fixture.ts';

const mutations = ['sendChat', 'createChat', 'stopChat'];

/** An open chat on a `TestClock`, whose watches the test drives. */
async function recovering(
  t: { after: (close: () => Promise<void>) => void },
  retry: number[],
  options: { local?: boolean; healthyMs?: number } = {},
) {
  const { local = true, healthyMs = 60_000 } = options;
  const f = await chatFixture(t, {
    local,
    testClock: true,
    dependencies: { transcriptLimits: { watchRetryMs: retry, watchHealthyMs: healthyMs } },
  });
  await f.start();
  if (!local) await f.connect();
  await f.select(target);
  /** Advances the clock a millisecond at a time until `check` holds. */
  const until = async (check: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 200 && !(await check()); i++) {
      await f.adjust(1);
      await turn();
    }
    assert(await check());
  };
  return { f, until };
}

const observation = async (f: ChatFixture) => (await f.state()).transcript.observation;

test('a retryable stream failure re-watches the selected chat without resending, fencing the old watch', async (t) => {
  const { f, until } = await recovering(t, [5], { healthyMs: 10 });
  assert.equal(f.chatWatches.length, 1);
  f.chatWatches[0].fail(unavailable());
  await until(async () => (await observation(f)) === 'reconnecting');
  let state = await f.state();
  assert.equal(state.error, null);
  assert.equal(state.snapshot?.observationStatus, 'reconnecting');
  assert.equal(f.chatWatches[0].closed, true, 'the failed subscription closes before the backoff');
  assert.equal(f.chatWatches.length, 1);

  await until(async () => f.chatWatches.length === 2 && (await observation(f)) === 'local');
  assert.equal(f.chatWatches[1].closed, false);
  assert.equal(f.calls.filter((call) => call.operation === 'getChat').length, 2);
  assert.equal((await f.state()).snapshot?.observationStatus, undefined);

  state = await f.state();
  f.chatWatches[0].receive({
    ...snapshot,
    conversation: { ...snapshot.conversation, title: 'Late' },
  });
  await turn();
  assert.equal((await f.state()).snapshot?.conversation.title, state.snapshot?.conversation.title);
  f.chatWatches[1].receive({
    ...snapshot,
    conversation: { ...snapshot.conversation, title: 'Fresh' },
  });
  await until(async () => (await f.state()).snapshot?.conversation.title === 'Fresh');

  // A watch that stayed up for the healthy period after its first snapshot renews the cap.
  await f.adjust(30);
  f.chatWatches[1].fail(unavailable());
  await until(async () => f.chatWatches.length === 3 && (await observation(f)) === 'local');
  assert.deepEqual(
    f.calls.filter((call) => mutations.includes(call.operation)),
    [],
    'recovery only reads',
  );
});

test('consecutive stream failures stop at the cap with a clear error and a manual retry', async (t) => {
  const { f, until } = await recovering(t, [1]);
  f.chatWatches[0].fail(unavailable());
  await until(() => f.chatWatches.length === 2);
  f.chatWatches[1].fail(unavailable());
  await until(async () => (await observation(f)) === 'failed');
  let state = await f.state();
  assert.ok(state.error);
  assert.ok(state.transcript.error);
  await f.adjust(20);
  assert.equal(f.chatWatches.length, 2, 'no re-watch after the cap');
  assert.equal(f.chatWatches[1].closed, true, 'giving up releases the failed subscription');

  await f.refresh();
  await until(async () => f.chatWatches.length === 3 && (await observation(f)) === 'local');

  // A failure that is not retryable stops at once.
  f.chatWatches[2].fail(new IncompatibleHostError({ reason: 'invalid-update' }));
  await until(async () => (await observation(f)) === 'failed');
  await f.adjust(20);
  assert.equal(f.chatWatches.length, 3);
  state = await f.state();
  assert.equal(state.snapshot?.conversation.target.conversationId, target.conversationId);
});

test('a host that sends one snapshot per watch and then drops still reaches the cap', async (t) => {
  const { f, until } = await recovering(t, [1, 1]);
  for (let attempt = 0; attempt < 3; attempt++) {
    await until(() => f.chatWatches.length === attempt + 1);
    f.chatWatches[attempt].receive(snapshot);
    await turn();
    f.chatWatches[attempt].fail(unavailable());
  }
  await until(async () => (await observation(f)) === 'failed');
  await f.adjust(20);
  assert.equal(f.chatWatches.length, 3);
});

test('a transcript that already failed is not re-watched after the stream drops', async (t) => {
  const { f, until } = await recovering(t, [1]);
  const other = { ...snapshot.conversation, target: { ...target, conversationId: 'x' } };
  f.chatWatches[0].receive({ ...snapshot, conversation: other });
  await until(async () => (await observation(f)) === 'failed');
  const failed = await f.state();
  f.chatWatches[0].fail(unavailable());
  await turn();
  await f.adjust(20);
  assert.equal(f.chatWatches.length, 1);
  assert.equal(f.chatWatches[0].closed, true);
  assert.equal(await observation(f), 'failed');
  assert.equal((await f.state()).error, failed.error, 'the original failure stays');

  await f.refresh();
  await until(async () => f.chatWatches.length === 2 && (await observation(f)) === 'local');
});

test('no re-watch after switching chats or disconnecting during the backoff', async (t) => {
  const switched = await recovering(t, [10]);
  switched.f.chatWatches[0].fail(unavailable());
  await switched.until(async () => (await observation(switched.f)) === 'reconnecting');
  switched.f.answers.set('getChat', (input: { target: typeof target }) => ({
    ...snapshot,
    conversation: { ...snapshot.conversation, target: input.target },
  }));
  await switched.f.select({ ...target, conversationId: 'other' });
  await switched.f.adjust(40);
  assert.equal(switched.f.chatWatches.length, 2, 'only the new chat is watched');
  assert.equal((await switched.f.state()).snapshot?.conversation.target.conversationId, 'other');

  const disconnected = await recovering(t, [10], { local: false });
  disconnected.f.chatWatches[0].fail(unavailable());
  await disconnected.until(async () => (await observation(disconnected.f)) === 'reconnecting');
  await disconnected.f.disconnect();
  await disconnected.f.adjust(40);
  assert.equal(disconnected.f.chatWatches.length, 1);
  assert.equal(await observation(disconnected.f), 'inactive');
});
