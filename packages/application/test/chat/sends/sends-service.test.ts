import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SubscriptionRef } from 'effect';
import type { ChatCommands } from '@moonbase/contracts/chat';
import { ChatSends, groupChatsByActivity, type Pending } from '@moonbase/application/chat';
import {
  chatFixture,
  context,
  openChat,
  running,
  settings,
  snapshot,
  summary,
  target,
  turn,
  uncertain,
  until,
  waitFor,
  type ChatFixture,
} from '../chat-fixture.ts';
import {
  admitted,
  begin,
  fillDrafts,
  inputs,
  mutations,
  operations,
  pendingOf,
  saved,
} from './sends-fixture.ts';

// The outbox is where a Send must never be duplicated or a draft lost, so it is tested
// exhaustively. Here: each command is reserved before it is sent, at most once at a time, and a
// draft typed meanwhile is kept. Recovery of a retained command is in sends-retry.test.ts.

test('first Send creates once and sends the captured message to its exact chat', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  await f.closeView();
  await f.setDraft('Explain the editor');
  assert.equal(f.count('createChat'), 0);
  await Promise.all([f.send(settings), f.send(settings)]);
  const [create] = inputs(f, 'createChat') as ChatCommands['createChat']['input'][];
  const sends = inputs(f, 'sendChat') as ChatCommands['sendChat']['input'][];
  assert.equal(f.count('createChat'), 1);
  assert.equal(create!.title, 'Explain the editor');
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0]!.target, target);
  assert.equal(sends[0]!.text, 'Explain the editor');
  const state = await f.state();
  assert.equal(state.draft, '');
  assert.equal(state.pending.length, 0);
});

test('startup only reads, and every command is kept before it is sent', async (t) => {
  const f = await chatFixture(t);
  await f.start();
  assert(!f.calls.some((call) => ['connect', ...mutations].includes(call.operation)));
  await openChat(f);
  await f.setDraft('captured');
  f.answers.set('sendChat', (input: ChatCommands['sendChat']['input']) => {
    assert.deepEqual(saved(f).pending[0].input, input);
    return admitted(input, 'one');
  });
  await f.send();
  const state = await f.state();
  assert.equal(state.draft, '');
  assert.equal(state.pending.length, 0);
});

test('first Send checks draft capacity before creating, and succeeds once a draft is cleared', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  await fillDrafts(f, 32);
  await f.closeView();
  await f.setDraft('Keep my first message');
  await f.send(settings);
  assert(!f.calls.some((call) => mutations.includes(call.operation)));
  let state = await f.state();
  assert.match(state.error!, /32 conversation drafts/);
  assert.equal(state.draft, 'Keep my first message');
  assert.equal(await f.preserve(), true);
  await f.select({ ...target, conversationId: 'draft-0' });
  await f.setDraft('');
  await f.closeView();
  await f.send(settings);
  assert.equal(f.count('createChat'), 1);
  assert.equal(f.count('sendChat'), 1);
  state = await f.state();
  assert.equal(state.draft, '');
});

test('typing while the first chat is created survives its captured first Send', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  await f.closeView();
  const reply = Promise.withResolvers<void>();
  f.answers.set('createChat', async (input: ChatCommands['createChat']['input']) => {
    await reply.promise;
    return { requestId: input.requestId, conversation: summary };
  });
  await f.setDraft('Captured first message');
  const sending = f.send(settings);
  await waitFor(() => f.count('createChat') === 1);
  await f.setDraft('Newer unsent edit');
  reply.resolve();
  await sending;
  assert.equal((await f.state()).draft, 'Newer unsent edit');
  assert.equal((inputs(f, 'sendChat')[0] as { text: string }).text, 'Captured first message');
});

test('a Retry while the first chat’s Create is still sent sends nothing, and a newer new-chat draft survives', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  await f.closeView();
  const created = Promise.withResolvers<void>(),
    sent = Promise.withResolvers<void>();
  f.answers.set('createChat', async (input: ChatCommands['createChat']['input']) => {
    await created.promise;
    return { requestId: input.requestId, conversation: summary };
  });
  f.answers.set('sendChat', async (input: ChatCommands['sendChat']['input']) => {
    await sent.promise;
    return admitted(input);
  });
  await f.setDraft('Captured first message');
  const sending = f.send(settings);
  await waitFor(() => f.count('createChat') === 1);
  const [pending] = (await f.state()).pending;
  assert(pending?.operation === 'createChat' && pending.firstMessage);
  await f.retry(pending.input.requestId);
  assert.equal(f.count('createChat'), 1);
  assert.equal(f.count('listChats'), 1);
  created.resolve();
  await waitFor(() => f.count('sendChat') === 1);
  // The created chat is selected; a new chat started while its first message is sent keeps its draft.
  await f.closeView();
  await f.setDraft('A different new conversation');
  sent.resolve();
  await sending;
  const state = await f.state();
  assert.equal(state.selected, null);
  assert.equal(state.draft, 'A different new conversation');
  assert.equal(state.error, null);
  assert.equal(state.storageError, null);
  assert.equal(state.pending.length, 0);
  assert.equal(saved(f).newDraft, 'A different new conversation');
  assert.equal(f.count('createChat'), 1);
  assert.equal(f.count('sendChat'), 1);
  assert.equal(await f.preserve(), true);
});

test('the draft limit reached during Create keeps it for an exact Retry once a slot is free', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  await fillDrafts(f, 31);
  await f.closeView();
  await f.setDraft('Captured first message');
  const reply = Promise.withResolvers<void>();
  f.answers.set('createChat', async (input: ChatCommands['createChat']['input']) => {
    await reply.promise;
    return { requestId: input.requestId, conversation: summary };
  });
  const sending = f.send(settings);
  await waitFor(() => f.count('createChat') === 1);
  await f.select({ ...target, conversationId: 'last-slot' });
  await f.setDraft('Another conversation draft');
  reply.resolve();
  await sending;
  const state = await f.state();
  assert.match(state.error!, /draft limit was reached/);
  const [retained] = state.pending;
  assert(retained?.operation === 'createChat' && retained.firstMessage);
  assert.equal(retained.firstMessage.text, 'Captured first message');
  assert.equal(f.count('sendChat'), 0);
  assert.equal(await f.preserve(), true);
  f.answers.delete('createChat');
  await f.setDraft('');
  await f.retry(retained.input.requestId);
  assert.equal(f.count('sendChat'), 1);
  assert.deepEqual(inputs(f, 'createChat'), [retained.input, retained.input]);
});

test('a first message that cannot be kept with its created chat is never sent', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  await f.closeView();
  await f.setDraft('Keep this message');
  f.answers.set('createChat', (input: ChatCommands['createChat']['input']) => {
    f.storage.fail = true;
    return { requestId: input.requestId, conversation: summary };
  });
  await f.send(settings);
  assert.equal(f.count('sendChat'), 0);
  assert.equal((await f.state()).draft, 'Keep this message');
  assert.equal(await f.preserve(), false);
});

test('an automatic title is bounded by UTF-8 bytes', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  await f.closeView();
  await f.setDraft('🌙'.repeat(100));
  await f.send(settings);
  const { title } = inputs(f, 'createChat')[0] as { title: string };
  assert.equal(new TextEncoder().encode(title).length, 80);
  assert.equal(title.isWellFormed(), true);
});

test('a local first Send needs a folder and model and keeps exactly the approved ones', async (t) => {
  const f = await chatFixture(t, { local: true });
  await f.start();
  await f.setDraft('Local first message');
  await f.send();
  assert.equal(f.count('createChat'), 0);
  assert.equal((await f.state()).draft, 'Local first message');
  assert.ok((await f.state()).error);
  const approved = {
    cwd: '/approved/project',
    model: { provider: 'configured', modelId: 'model' },
    reasoningEffort: 'xhigh' as const,
  };
  await f.send(approved);
  assert.deepEqual((inputs(f, 'createChat')[0] as { settings: unknown }).settings, approved);
  assert.equal(f.count('sendChat'), 1);
});

test('the configured context is copied: changing the caller’s object retargets nothing', async (t) => {
  const copy = structuredClone(context);
  const f = await chatFixture(t, { dependencies: { context: copy } });
  copy.actorId = 'foreign-actor';
  copy.host.hostId = 'foreign-host';
  await openChat(f);
  await f.create('Original authority', settings);
  assert.deepEqual((inputs(f, 'createChat')[0] as { session: unknown }).session, context);
  assert.deepEqual(saved(f).session, context);
});

test('an admitted Send clears only the captured draft text, keeping a newer edit', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  await f.setDraft('captured');
  const reply = Promise.withResolvers<void>();
  f.answers.set('sendChat', async (input: ChatCommands['sendChat']['input']) => {
    await reply.promise;
    return admitted(input, 'one');
  });
  const sending = f.send();
  await waitFor(() => f.count('sendChat') === 1);
  await f.setDraft('newer edit');
  reply.resolve();
  await sending;
  const state = await f.state();
  assert.equal(state.draft, 'newer edit');
  assert.equal(state.pending.length, 0);
});

for (const operation of operations)
  test(`${operation} is never sent when its reservation cannot be kept`, async (t) => {
    const f = await chatFixture(t);
    await openChat(f);
    await f.setDraft('retained');
    f.publish(running());
    await until(f, (state) => !!state.snapshot?.run);
    f.storage.fail = true;
    if (operation === 'createChat') await f.create('Title', settings);
    if (operation === 'sendChat') await f.send();
    if (operation === 'stopChat') await f.stop();
    assert.equal(f.count(operation), 0);
    const state = await f.state();
    assert.ok(state.storageError);
    assert.equal(state.draft, 'retained');
    assert.equal(await f.preserve(), false);
  });

test('a held Send runs beside a captured Stop, and closing the view stops neither', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  await f.setDraft('wait');
  const reply = Promise.withResolvers<void>();
  f.answers.set('sendChat', async (input: ChatCommands['sendChat']['input']) => {
    await reply.promise;
    return { ...admitted(input), admission: 'reserved', submissionId: null };
  });
  const sending = f.send();
  await waitFor(() => f.count('sendChat') === 1);
  await begin(f, 'stopChat');
  assert.equal(f.count('stopChat'), 1);
  await f.closeView();
  assert.equal(f.subscriptions, 0);
  assert.equal(f.signals.get('sendChat')!.at(-1)!.aborted, false);
  reply.resolve();
  await sending;
  assert.equal(f.count('stopChat'), 1);
  assert.equal((await f.state()).pending.length, 1);
});

test('a Create’s receipt does not wait for the created chat’s first read, which a newer selection supersedes', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  await f.closeView();
  const held = Promise.withResolvers<void>();
  f.answers.set('getChat', async (input: ChatCommands['getChat']['input']) => {
    if (input.target.conversationId === target.conversationId) await held.promise;
    return {
      ...snapshot,
      conversation: { ...summary, target: input.target, title: input.target.conversationId },
    };
  });
  await f.create('Captured creation', settings);
  assert.equal((await f.state()).pending.length, 0);
  await f.select({ ...target, conversationId: 'B' });
  held.resolve();
  await turn();
  const state = await f.state();
  assert.equal(state.snapshot!.conversation.title, 'B');
  assert.equal(state.error, null);
  assert.equal(f.count('createChat'), 1);
});

for (const operation of ['createChat', 'sendChat'] as const)
  test(`closing the chat abandons a held ${operation} without writing; it stays retained, and the closed chat admits nothing`, async (t) => {
    const f = await chatFixture(t);
    await openChat(f);
    await f.setDraft('first retained');
    const reply = Promise.withResolvers<void>();
    f.answers.set(operation, async (input: { requestId: string }) => {
      await reply.promise;
      return operation === 'createChat'
        ? { requestId: input.requestId, conversation: summary }
        : admitted(input);
    });
    // A Send the composer started is the chat's own work: closing never waits for its reply.
    const call =
      operation === 'sendChat'
        ? f.runtime.runPromise(f.composer().send({ key: 'chat', initialCwd: '' }, {}))
        : begin(f, operation);
    await waitFor(() => f.count(operation) === 1);
    const pending = await pendingOf(f);
    const kept = f.storage.value,
      writes = f.storage.writes;
    await f.close();
    assert.equal(f.signals.get(operation)!.at(-1)!.aborted, true);
    await call;
    await f.setDraft('late edit');
    await f.create('Late admission', settings);
    reply.resolve();
    await turn();
    assert.equal(f.storage.value, kept);
    assert.equal(f.storage.writes, writes);
    assert.deepEqual(JSON.parse(kept!).pending, pending);
    assert.equal(f.count('createChat'), operation === 'createChat' ? 1 : 0);
    assert.equal(f.subscriptions, 0);
    await f.reopen();
    assert.deepEqual((await f.state()).pending, pending);
  });

/** Checks, at each write of the drafts while `check` is set, that every retained Send is in flight. */
function watchWrites(f: ChatFixture, check: (pending: Pending[], dispatching: string[]) => void) {
  const sends = f.service(ChatSends);
  f.storage.onWrite = (value) =>
    check(
      JSON.parse(value).pending,
      Object.keys(SubscriptionRef.getUnsafe(sends.state).dispatching),
    );
}

test('a Send is dispatching from its reservation, and only an uncertain one counts as Ready', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  const reasons = async () => {
    const state = await f.state();
    return groupChatsByActivity({
      chats: [summary],
      pending: state.pending,
      dispatching: state.dispatching,
    }).ready.map((row) => row.reason);
  };
  const reply = Promise.withResolvers<void>();
  f.answers.set('sendChat', async () => {
    await reply.promise;
    throw uncertain();
  });
  let reservations = 0;
  watchWrites(f, (pending, dispatching) => {
    if (!pending.length || reservations++) return;
    // The Send is counted as in flight before its reservation is kept.
    assert.deepEqual(dispatching, [pending[0]!.input.requestId]);
  });
  await f.setDraft('Hello');
  const sending = f.send();
  await waitFor(() => f.count('sendChat') === 1);
  f.storage.onWrite = undefined;
  assert(reservations > 0);
  const id = (await f.state()).pending[0]!.input.requestId;
  assert.deepEqual((await f.state()).dispatching, [id]);
  assert.deepEqual(await reasons(), []);
  reply.resolve();
  await sending;
  assert.deepEqual((await f.state()).dispatching, []);
  assert.equal((await f.state()).pending.length, 1);
  assert.deepEqual(await reasons(), ['unconfirmed']);
  // An explicit retry is in flight again until it is admitted.
  const retried = Promise.withResolvers<void>();
  f.answers.set('sendChat', async (input: ChatCommands['sendChat']['input']) => {
    await retried.promise;
    return admitted(input, 's');
  });
  const retrying = f.retry(id);
  await waitFor(() => f.count('sendChat') === 2);
  assert.deepEqual((await f.state()).dispatching, [id]);
  assert.deepEqual(await reasons(), []);
  retried.resolve();
  await retrying;
  const state = await f.state();
  assert.deepEqual(state.dispatching, []);
  assert.deepEqual(state.pending, []);
});

test('a new chat’s first message is in flight from the moment its Create is answered', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  await f.closeView();
  const reply = Promise.withResolvers<void>();
  f.answers.set('sendChat', async (input: ChatCommands['sendChat']['input']) => {
    await reply.promise;
    return admitted(input, 's');
  });
  let checked = 0;
  watchWrites(f, (pending, dispatching) => {
    for (const item of pending)
      if (item.operation === 'sendChat') {
        checked++;
        assert(dispatching.includes(item.input.requestId));
      }
  });
  await f.setDraft('First message');
  const sending = f.send(settings);
  await waitFor(() => f.count('sendChat') === 1);
  assert.equal((await f.state()).pending[0]!.operation, 'sendChat');
  reply.resolve();
  await sending;
  f.storage.onWrite = undefined;
  assert(checked > 0);
  assert.deepEqual((await f.state()).dispatching, []);
});
