import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chatFixture,
  openChat,
  running,
  settings,
  snapshot,
  summary,
  target,
  unavailable,
  uncertain,
  until,
  waitFor,
} from '../chat-fixture.ts';
import {
  admitted,
  begin,
  inputs,
  operations,
  mutations,
  pendingOf,
  restart,
  saved,
} from './sends-fixture.ts';

// A command whose outcome is lost stays retained, Uncertain, with its original identity: Refresh
// and Query only read, and only an explicit Retry sends it again, under that identity, once the
// drafts can still be kept.

test('Create and a captured Stop are kept before they are sent, and lost replies reopen exactly', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  for (const operation of ['createChat', 'stopChat'])
    f.answers.set(operation, (input: unknown) => {
      assert.deepEqual(saved(f).pending.at(-1).input, input);
      throw uncertain();
    });
  await f.create('Preserved creation', settings);
  await begin(f, 'stopChat', running({ target, submissionId: 'saved-submission', taskId: null }));
  const retained = await pendingOf(f);
  assert.equal(retained.length, 2);
  await f.reopen();
  assert.deepEqual((await f.state()).pending, retained);
});

test('a lost first-chat Create keeps both identities across a restart and sends only on its Retry', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  await f.closeView();
  f.answers.set('createChat', () => {
    throw uncertain();
  });
  await f.setDraft('Original first message');
  await f.send(settings);
  const [pending] = (await f.state()).pending;
  assert(pending?.operation === 'createChat' && pending.firstMessage);
  await f.setDraft('Newer edit');
  await restart(f, {
    newId: () => {
      throw Error('Must keep the original IDs');
    },
  });
  assert.equal(f.count('sendChat'), 0);
  f.answers.delete('createChat');
  await f.retry(pending.input.requestId);
  const creates = inputs(f, 'createChat');
  assert.equal(creates.length, 2);
  assert.deepEqual(creates[0], creates[1]);
  assert.deepEqual(inputs(f, 'sendChat'), [{ ...pending.firstMessage, target }]);
  assert.equal((await f.state()).draft, 'Newer edit');
});

test('an Uncertain first Send stays retained and its Retry creates no other chat', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  await f.closeView();
  f.answers.set('sendChat', () => {
    throw uncertain();
  });
  await f.setDraft('First message');
  await f.send(settings);
  const [pending] = (await f.state()).pending;
  assert.equal(pending?.operation, 'sendChat');
  await restart(f);
  // Refresh queries it, and never resends.
  assert(f.count('getChatSend') >= 1);
  assert.equal(f.count('sendChat'), 1);
  f.answers.delete('sendChat');
  await f.retry(pending!.input.requestId);
  assert.equal(f.count('createChat'), 1);
  assert.deepEqual(inputs(f, 'sendChat')[1], pending!.input);
});

test('a first-message Create Retry keeps an edited draft of the found chat and a newer new-chat draft', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  await f.closeView();
  f.answers.set('createChat', () => {
    throw uncertain();
  });
  await f.setDraft('Captured first message');
  await f.send(settings);
  const [pending] = (await f.state()).pending;
  await f.setDraft('New unsent conversation');
  await f.select(target);
  await f.setDraft('Edited discovered conversation');
  f.answers.delete('createChat');
  await f.retry(pending!.input.requestId);
  let state = await f.state();
  assert.equal(state.draft, 'Edited discovered conversation');
  assert.equal(state.storageError, null);
  await f.closeView();
  state = await f.state();
  assert.equal(state.draft, 'New unsent conversation');
});

test('a lost reply, a null query, a restart and a reconnect keep the original Send without resending', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  await f.setDraft('original');
  f.answers.set('sendChat', () => {
    throw uncertain();
  });
  await f.send();
  const [pending] = (await f.state()).pending;
  assert(pending?.operation === 'sendChat');
  assert.equal(pending.input.text, 'original');
  await f.query(pending.input.requestId);
  assert.deepEqual((await f.state()).pending[0]!.input, pending.input);
  await restart(f);
  assert.deepEqual((await f.state()).pending[0]!.input, pending.input);
  assert.equal(f.count('sendChat'), 1);
  await f.disconnect();
  await f.connect();
  await until(f, (state) => state.ready);
  assert.equal(f.count('sendChat'), 1);
});

test('a query that finds the Send admitted resolves it without sending, keeping a newer draft', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  await f.setDraft('Original');
  f.answers.set('sendChat', () => {
    throw uncertain();
  });
  await f.send();
  const [pending] = (await f.state()).pending;
  f.answers.set('getChatSend', () => admitted(pending!.input, 'one'));
  await f.setDraft('newer');
  await f.query(pending!.input.requestId);
  const state = await f.state();
  assert.equal(state.pending.length, 0);
  assert.equal(state.draft, 'newer');
  assert.equal(f.count('sendChat'), 1);
});

test('an Uncertain Send whose failure note cannot be kept stays retained as it was reserved', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  await f.setDraft('original uncertain input');
  f.answers.set('sendChat', () => {
    f.storage.fail = true;
    throw uncertain('Controlled mutation outcome uncertainty');
  });
  await f.send();
  const state = await f.state();
  assert.ok(state.error);
  assert.ok(state.storageError);
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0]!.operation, 'sendChat');
  assert.deepEqual(saved(f).pending[0].input, state.pending[0]!.input);
  assert.equal(f.count('sendChat'), 1);
});

test('Retry queries first, repeats each original identity and never adopts a successor task', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  for (const operation of operations)
    f.answers.set(operation, () => {
      throw uncertain();
    });
  await f.create('Original title', settings);
  await f.setDraft('Original message');
  await f.send();
  await begin(
    f,
    'stopChat',
    running({ target, submissionId: 'original', taskId: 'original-task' }),
  );
  const pending = await pendingOf(f);
  assert.deepEqual(
    pending.map((item) => item.operation),
    operations,
  );
  f.publish(running({ target, submissionId: 'later', taskId: 'successor' }));
  await until(f, (state) => state.snapshot?.run?.stop.taskId === 'successor');
  const queries = ['listChats', 'getChatSend', 'getChat'];
  for (const item of pending) {
    const before = f.calls.length;
    await f.retry(item.input.requestId);
    const made = f.calls
      .slice(before)
      .filter((call) => [...queries, ...mutations].includes(call.operation));
    assert(queries.includes(made[0]!.operation), item.operation);
    assert.deepEqual(made.at(-1), { operation: item.operation, input: item.input });
  }
  assert.deepEqual(
    (await f.state()).pending.map((item) => item.input),
    pending.map((item) => item.input),
  );
});

for (const operation of operations)
  test(`${operation} keeps its identity when Disconnect makes its sent reply Unavailable, and only Retry repeats it`, async (t) => {
    const f = await chatFixture(t);
    await openChat(f);
    await f.setDraft('captured before disconnect');
    const reply = Promise.withResolvers<void>();
    f.answers.set(operation, async () => {
      await reply.promise;
      throw unavailable('Connection generation gone after dispatch');
    });
    const call = begin(f, operation, running({ target, submissionId: 'admitted', taskId: 'task' }));
    await waitFor(() => f.count(operation) === 1);
    const [original] = await pendingOf(f);
    await f.disconnect();
    reply.resolve();
    await call;
    assert.deepEqual((await f.state()).pending[0]!.input, original!.input);
    await restart(f);
    assert.deepEqual((await f.state()).pending[0]!.input, original!.input);
    assert.equal(f.count(operation), 1);
    f.answers.delete(operation);
    await f.retry(original!.input.requestId);
    assert.equal(f.count(operation), 2);
    assert.deepEqual(inputs(f, operation).at(-1), original!.input);
  });

/** What a Retry or Query of each command reads first. */
const queryOf = { createChat: 'listChats', sendChat: 'getChatSend', stopChat: 'getChat' } as const;
for (const operation of operations)
  for (const duringQuery of [false, true])
    for (const failsWrite of [false, true])
      test(`${operation} Retry is refused when storage ${failsWrite ? 'refuses writes' : 'changed elsewhere'} ${duringQuery ? 'during its query' : 'before it'}, and Query still reads`, async (t) => {
        const f = await chatFixture(t);
        await openChat(f);
        await f.setDraft('captured draft');
        f.answers.set(operation, (input: { requestId: string }) => {
          if (operation === 'sendChat')
            return { ...admitted(input), admission: 'reserved', submissionId: null };
          throw uncertain();
        });
        await begin(f, operation, running({ target, submissionId: 'original', taskId: 'task' }));
        await f.setDraft('newer live edit');
        const [retained] = await pendingOf(f);
        const external = saved(f);
        external.drafts[0].text = 'newer externally published edit';
        const replacement = failsWrite ? f.storage.value : JSON.stringify(external);
        const breakStorage = () => {
          if (failsWrite) f.storage.fail = true;
          else f.storage.value = replacement;
        };
        const query = queryOf[operation];
        f.answers.set(query, () => {
          if (duringQuery) breakStorage();
          if (operation === 'createChat') return { conversations: [summary], nextCursor: null };
          if (operation === 'sendChat')
            return { ...admitted(retained!.input), admission: 'reserved', submissionId: null };
          return snapshot;
        });
        f.answers.delete(operation);
        if (!duringQuery) breakStorage();
        await f.retry(retained!.input.requestId);
        assert.equal(f.count(operation), 1, 'keeping the drafts must refuse before the command');
        assert.equal(f.storage.value, replacement);
        const state = await f.state();
        assert.deepEqual(state.pending[0]!.input, retained!.input);
        assert.equal(state.draft, 'newer live edit');
        assert.ok(state.storageError);
        const queries = f.count(query);
        await f.query(retained!.input.requestId);
        assert(f.count(query) > queries, 'a read-only query stays available');
        assert.equal(f.count(operation), 1);
      });
