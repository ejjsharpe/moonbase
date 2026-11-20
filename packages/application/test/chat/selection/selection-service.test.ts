import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect } from 'effect';
import type { ChatCommands, ChatInput, ChatSnapshot } from '@moonbase/contracts/chat';
import { ChatSelection } from '@moonbase/application/chat';
import {
  chatFixture,
  connected,
  context,
  makeEntry,
  openChat,
  snapshot,
  summary,
  target,
  unavailable,
  until,
  waitFor,
} from '../chat-fixture.ts';

const titled = (title: string, conversationId = target.conversationId): ChatSnapshot => ({
  ...snapshot,
  conversation: { ...summary, target: { ...target, conversationId }, title },
});

test('Select while the host is being verified only records it, and the running Refresh opens it; after a failed Refresh it verifies again', async (t) => {
  const f = await chatFixture(t);
  await f.start();
  const held = Promise.withResolvers<void>();
  f.answers.set('getChatHost', async () => {
    await held.promise;
    return { ...context, mode: 'local' };
  });
  await f.connect();
  await waitFor(() => f.count('getChatHost') === 1);
  await f.select(target);
  let state = await f.state();
  assert.deepEqual(state.selected, target);
  assert.equal(f.count('getChat'), 0);
  // Another context's chat is refused and leaves the selection.
  await f.select({ ...target, actorId: 'stranger' });
  state = await f.state();
  assert.match(state.error!, /another context/);
  assert.deepEqual(state.selected, target);
  held.resolve();
  state = await until(f, (s) => !!s.snapshot);
  assert.deepEqual(state.snapshot!.conversation.target, target);
  assert.equal(f.subscriptions, 1);

  // A new generation whose Refresh fails leaves nothing verifying: a Select of a listed chat
  // verifies the host again and opens it, never just clearing the error.
  f.answers.set('getChatHost', () => {
    throw unavailable();
  });
  f.publishConnection(connected('next-generation'));
  await until(f, (s) => s.connection?.connectionId === 'next-generation' && !!s.error);
  f.answers.delete('getChatHost');
  const hosts = f.count('getChatHost');
  const other = { ...target, conversationId: 'listed' };
  await f.select(other);
  state = await until(f, (s) => !!s.snapshot);
  assert.equal(f.count('getChatHost'), hosts + 1);
  assert.equal(state.snapshot!.conversation.target.conversationId, 'listed');
  assert.equal(state.error, null);
});

test('closing the view during the first Refresh leaves it to verify and list, opening nothing', async (t) => {
  const f = await chatFixture(t);
  await f.start();
  await f.select(target);
  const held = Promise.withResolvers<void>();
  f.answers.set('listChats', async () => {
    await held.promise;
    return { conversations: [{ ...summary, title: 'Listed' }], nextCursor: null };
  });
  await f.connect();
  await waitFor(() => f.count('listChats') === 1);
  await f.closeView();
  held.resolve();
  const state = await until(f, (s) => s.chats[0]?.title === 'Listed');
  assert.ok(state.host);
  assert.equal(state.selected, null);
  assert.equal(f.count('getChat'), 0);
  assert.equal(f.subscriptions, 0);
});

test('a superseded selection’s late reads and snapshots never land', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  const firstA = Promise.withResolvers<ChatSnapshot>(),
    firstB = Promise.withResolvers<ChatSnapshot>();
  let reads = 0;
  f.answers.set('getChat', (input: ChatCommands['getChat']['input']) => {
    if (input.target.conversationId === 'B') return firstB.promise;
    return ++reads === 1 ? firstA.promise : titled('Current A');
  });
  const watched = f.chatWatches.length;
  const openingA = f.select(target),
    openingB = f.select({ ...target, conversationId: 'B' });
  await f.select(target);
  assert.equal(f.subscriptions, 1);
  assert.equal((await f.state()).snapshot!.conversation.title, 'Current A');
  const [watchA, watchB] = f.chatWatches.slice(watched);
  assert(watchA!.closed && watchB!.closed);
  watchA!.receive(titled('Obsolete A watch'));
  watchB!.receive(titled('Obsolete B watch', 'B'));
  firstA.resolve(titled('Obsolete A read'));
  firstB.resolve(titled('Obsolete B read', 'B'));
  await Promise.all([openingA, openingB]);
  const state = await f.state();
  assert.equal(state.snapshot!.conversation.title, 'Current A');
  assert.equal(state.error, null);
  assert.deepEqual(
    f.signals
      .get('getChat')!
      .slice(-3)
      .map((signal) => signal.aborted),
    [true, true, false],
  );
});

test('watch snapshots replace each other, and overlapping history pages stay bounded', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  const latest = (text: string): ChatSnapshot => ({
    ...snapshot,
    entries: [makeEntry('entry', text)],
    olderCursor: 'page',
    transcriptBoundary: 'entry',
  });
  for (let n = 0; n < 50; n++) f.publish(latest(String(n)));
  let state = await until(f, (s) => s.snapshot?.entries[0]?.text === '49');
  assert.equal(state.snapshot!.entries.length, 1);
  let pages = 0;
  // Every page repeats the same window of entries.
  f.answers.set('getChatHistoryAround', (input: ChatInput<'getChatHistoryAround'>) => ({
    target,
    cursor: input.cursor ?? null,
    entryId: input.entryId,
    upperEntryId: 'entry',
    entries: [
      makeEntry('entry', '49'),
      ...Array.from({ length: 31 }, (_, n) => makeEntry('older-' + n, 'bounded', 'user')),
    ],
    olderCursor: 'next-' + ++pages,
    newerCursor: null,
  }));
  for (let page = 1; page <= 4; page++) {
    await f.run(Effect.flatMap(ChatSelection, (selection) => selection.showEarlier));
    await waitFor(() => pages === page);
  }
  state = await until(f, (s) => s.transcript.entries.length > 1);
  assert.equal(state.transcript.error, null);
  assert.equal(state.transcript.entries.length, 32);
});

test('a watch that fails with an unknown error shows fixed text, never its message', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  f.chatWatches.at(-1)!.fail(Error('SYNTHETIC_PRIVATE_SENTINEL'));
  const state = await until(f, (s) => s.transcript.observation === 'failed');
  assert.ok(state.error);
  assert(!state.error.includes('SYNTHETIC_PRIVATE_SENTINEL'));
  assert.equal(f.subscriptions, 0);
});

test('closing the chat a move to the new chat left leaves a chat chosen since open', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  const other = { ...target, conversationId: 'other' };
  await f.select(other);
  await until(f, (s) => s.ready && s.snapshot?.conversation.target.conversationId === 'other');
  const closeDeselected = (closed: typeof target) =>
    f.run(Effect.flatMap(ChatSelection, (selection) => selection.closeDeselected(closed)));
  // The chat `/new` left was superseded, and the one selected is not deselected.
  await closeDeselected(target);
  await closeDeselected(other);
  const state = await f.state();
  assert.equal(state.selected?.conversationId, 'other');
  assert.equal(state.snapshot?.conversation.target.conversationId, 'other');
});
