import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatCommands, ChatInput, ChatSummary } from '@moonbase/contracts/chat';
import { UnauthorizedError } from '@moonbase/contracts/errors';
import { IncompatibleHostError } from '@moonbase/contracts/host-errors';
import { groupChatsByActivity } from '@moonbase/application/chat';
import {
  chatFixture,
  connected,
  context,
  openChat,
  settings,
  summary,
  target,
  turn,
  unavailable,
  uncertain,
  until,
  waitFor,
  type ChatFixture,
} from '../chat-fixture.ts';

const listings = (f: ChatFixture) => f.count('listChats');
const created = (input: ChatCommands['createChat']['input']) => ({
  requestId: input.requestId,
  conversation: { ...summary, target: { ...context, conversationId: 'created' } },
});

test('a listing reads every page, and the first marks what is already there as seen', async (t) => {
  const f = await chatFixture(t);
  const chat = (id: string, at: string) => ({
    ...summary,
    target: { ...context, conversationId: id },
    activity: { state: 'idle' as const, at },
  });
  f.answers.set('listChats', (input: { cursor?: string }) =>
    input.cursor === 'page-2'
      ? { conversations: [chat('old', '2026-11-07T09:00:00Z')], nextCursor: null }
      : { conversations: [chat('new', '2026-11-07T10:00:00Z')], nextCursor: 'page-2' },
  );
  await f.start();
  await f.connect();
  const state = await until(f, (s) => s.chats.length === 2);
  assert.deepEqual(
    state.chats.map((item) => item.target.conversationId),
    ['new', 'old'],
  );
  assert.equal(state.nextChats, null);
  assert.deepEqual(state.seen, [
    { conversationId: 'new', at: '2026-11-07T10:00:00Z' },
    { conversationId: 'old', at: '2026-11-07T09:00:00Z' },
  ]);
  // A later look replaces the earlier one; an older one never does.
  await f.markSeen('old', '2026-11-07T11:00:00Z');
  await f.markSeen('old', '2026-11-07T08:00:00Z');
  const newest = { conversationId: 'old', at: '2026-11-07T11:00:00Z' };
  assert.deepEqual((await f.state()).seen?.[0], newest);
  assert.deepEqual(JSON.parse(f.storage.value!).seen[0], newest);
});

test('a background reload lists again, keeping the last list and showing nothing when it fails', async (t) => {
  const f = await chatFixture(t);
  await f.start();
  await f.reloadChats();
  assert.equal(listings(f), 0);
  await f.connect();
  await until(f, (s) => s.ready && s.chats.length === 1);
  f.answers.set('listChats', () => {
    throw uncertain();
  });
  await f.reloadChats();
  let state = await f.state();
  assert.equal(state.chats.length, 1);
  assert.equal(state.error, null);
  f.answers.set('listChats', () => ({
    conversations: [{ ...summary, title: 'Renamed' }],
    nextCursor: null,
  }));
  await f.reloadChats();
  state = await f.state();
  assert.equal(state.chats[0]!.title, 'Renamed');
  assert.deepEqual(state.active, []);
});

test('Settle shows the host’s reply in the list and the open chat, and is refused off its host', async (t) => {
  const f = await chatFixture(t);
  await f.start();
  await f.settle(target, true);
  assert.equal(f.count('settleChat'), 0);
  assert.ok((await f.state()).error);
  const activity = { state: 'idle' as const, at: '2026-01-02T00:00:00Z' };
  // The host lists the chat as settled once a settle reply has been sent.
  let hostSettledAt: string | undefined;
  f.answers.set('listChats', () => ({
    conversations: [
      { ...summary, activity, ...(hostSettledAt ? { settledAt: hostSettledAt } : {}) },
    ],
    nextCursor: null,
  }));
  await openChat(f);
  const settledAt = '2026-02-01T00:00:00Z';
  f.answers.set('settleChat', (input: ChatCommands['settleChat']['input']) => {
    hostSettledAt = input.settled ? settledAt : undefined;
    return hostSettledAt ? { ...summary, settledAt } : summary;
  });
  await f.settle(target, true);
  assert.deepEqual(
    f.calls.filter((call) => call.operation === 'settleChat').map((call) => call.input),
    [{ target, settled: true }],
  );
  let state = await f.state();
  assert.equal(state.error, null);
  // The listing keeps its activity, which only listings carry.
  assert.deepEqual(state.chats[0], { ...summary, settledAt, activity });
  assert.equal(state.snapshot?.conversation.settledAt, settledAt);
  // A later listing keeps the host's settled state.
  let before = listings(f);
  await f.reloadChats();
  assert(listings(f) > before);
  assert.deepEqual((await f.state()).chats[0], { ...summary, settledAt, activity });
  before = listings(f);
  await f.settle(target, false);
  state = await f.state();
  assert.equal('settledAt' in state.chats[0]!, false);
  assert.equal(state.snapshot?.conversation.settledAt, undefined);
  assert.deepEqual(state.active, []);
  // A refusal is shown and changes nothing.
  f.answers.set('settleChat', () => {
    throw new UnauthorizedError({ operation: 'Settle' });
  });
  await f.settle(target, true);
  state = await f.state();
  assert.ok(state.error);
  assert.equal(state.chats[0]!.settledAt, undefined);
  // Another context's chat is refused before reaching the host.
  const count = f.calls.length;
  await f.settle({ ...target, actorId: 'stranger' }, true);
  assert.equal(f.calls.length, count);
  assert.match((await f.state()).error!, /another context/);
});

/** A host listing one chat per page, `page-chat-0` newest; `update` changes a chat's summary. */
function pagedChats(f: ChatFixture, pages: number) {
  const changes = new Map<number, Partial<ChatSummary>>();
  let calls = 0,
    gate: Promise<void> | undefined;
  f.answers.set('listChats', async (input: { cursor?: string }) => {
    calls++;
    const page = input.cursor ? Number(input.cursor.slice('page-'.length)) : 0;
    const chat = {
      ...summary,
      target: { ...context, conversationId: 'page-chat-' + page },
      title: 'Chat ' + page,
      ...changes.get(page),
    };
    if (page === 0 && gate) await gate;
    return { conversations: [chat], nextCursor: page + 1 < pages ? `page-${page + 1}` : null };
  });
  return {
    update: (page: number, change: Partial<ChatSummary>) => changes.set(page, change),
    /** Holds the next first-page read until the returned release is called. */
    hold() {
      const held = Promise.withResolvers<void>();
      gate = held.promise;
      return () => {
        gate = undefined;
        held.resolve();
      };
    },
    get calls() {
      return calls;
    },
  };
}
const shownIds = async (f: ChatFixture) =>
  (await f.state()).chats.map((chat) => chat.target.conversationId);
const pageIds = (count: number) => Array.from({ length: count }, (_, n) => 'page-chat-' + n);
/** Connects and waits for the first listing, which reads up to 16 pages. */
async function listFirst(f: ChatFixture, pages: number) {
  await f.start();
  await f.connect();
  await until(f, (s) => s.ready && s.chats.length === Math.min(pages, 16));
}

test('a background reload reads again through the older chats Show older added', async (t) => {
  const f = await chatFixture(t);
  const list = pagedChats(f, 20);
  list.update(17, { activity: { state: 'running', at: '2026-11-07T10:00:00Z' } });
  await listFirst(f, 20);
  assert.equal((await f.state()).nextChats, 'page-16');
  await f.moreChats();
  await f.moreChats();
  assert.deepEqual(await shownIds(f), pageIds(18));
  assert.equal((await f.state()).nextChats, 'page-18');
  assert.equal((await f.state()).chats[17]!.activity?.state, 'running');
  // The older chat finishes on the host, and the newest is renamed.
  list.update(17, { activity: { state: 'idle', at: '2026-11-07T10:05:00Z' } });
  list.update(0, { title: 'Renamed' });
  const before = list.calls;
  await f.reloadChats();
  assert.equal(list.calls - before, 18);
  const state = await f.state();
  assert.deepEqual(await shownIds(f), pageIds(18));
  assert.deepEqual(state.chats[17]!.activity, { state: 'idle', at: '2026-11-07T10:05:00Z' });
  assert.equal(state.chats[0]!.title, 'Renamed');
  assert.equal(state.nextChats, 'page-18');
  await f.moreChats();
  assert.equal((await shownIds(f)).at(-1), 'page-chat-18');
  // A creation keeps the older chats too.
  f.answers.set('createChat', created);
  await f.create('Created', settings);
  assert.deepEqual(await shownIds(f), ['created', ...pageIds(19)]);
  // A Show older keeps what landed while its page was read.
  const read = f.answers.get('listChats')!,
    older = Promise.withResolvers<void>();
  f.answers.set('listChats', async (input: { cursor?: string }, signal) => {
    if (input.cursor) await older.promise;
    return read(input as never, signal);
  });
  const showing = f.moreChats();
  await waitFor(() => f.calls.at(-1)?.operation === 'listChats');
  f.answers.set('createChat', (input: ChatCommands['createChat']['input']) => ({
    ...created(input),
    conversation: {
      ...created(input).conversation,
      target: { ...target, conversationId: 'later' },
    },
  }));
  await f.create('Created later', settings);
  older.resolve();
  await showing;
  assert.deepEqual(await shownIds(f), ['later', 'created', ...pageIds(20)]);
});

test('a background reload reads a bounded depth and keeps the chats past it as listed', async (t) => {
  const f = await chatFixture(t);
  const list = pagedChats(f, 70);
  await listFirst(f, 70);
  for (let page = 16; page < 68; page++) await f.moreChats();
  assert.deepEqual(await shownIds(f), pageIds(68));
  list.update(63, { title: 'Reached' });
  list.update(66, { title: 'Past the bound' });
  const before = list.calls;
  await f.reloadChats();
  assert.equal(list.calls - before, 64);
  const state = await f.state();
  assert.deepEqual(await shownIds(f), pageIds(68));
  assert.equal(state.chats[63]!.title, 'Reached');
  assert.equal(state.chats[66]!.title, 'Chat 66');
  assert.equal(state.nextChats, 'page-68');
});

test('a chat created while a complete listing reloads stays first', async (t) => {
  const f = await chatFixture(t);
  const list = pagedChats(f, 3);
  await listFirst(f, 3);
  assert.equal((await f.state()).nextChats, null);
  const release = list.hold();
  const before = list.calls;
  const reloading = f.reloadChats();
  await waitFor(() => list.calls === before + 1);
  f.answers.set('createChat', created);
  await f.create('Created', settings);
  assert.deepEqual(await shownIds(f), ['created', ...pageIds(3)]);
  release();
  await reloading;
  assert.deepEqual(await shownIds(f), ['created', ...pageIds(3)]);
  assert.equal((await f.state()).nextChats, null);
});

test('a reload a new connection generation interrupts leaves the next one free to list', async (t) => {
  const f = await chatFixture(t);
  await f.start();
  await f.connect();
  await until(f, (s) => s.ready && s.chats.length === 1);
  let count = 0;
  const held = Promise.withResolvers<void>();
  f.answers.set('listChats', async () => {
    count++;
    await held.promise;
    return { conversations: [summary], nextCursor: null };
  });
  const interrupted = f.reloadChats();
  await waitFor(() => count === 1);
  f.answers.delete('listChats');
  f.publishConnection(connected('next-generation'));
  await interrupted;
  await until(f, (s) => s.ready && s.connection?.connectionId === 'next-generation');
  const before = listings(f);
  await f.reloadChats();
  assert.equal(listings(f), before + 1);
});

test('the chat list follows its watch: changes merge without listing, and a reset or a reconnected watch lists again', async (t) => {
  const f = await chatFixture(t, { dependencies: { transcriptLimits: { watchRetryMs: [0] } } });
  const page = (conversations: ChatSummary[], changed: ChatSummary[] = [], dropped = 0) => ({
    list: { conversations, nextCursor: null },
    changed,
    dropped,
    reset: false,
  });
  // The watch opens before the first listing, so a chat past the first page that changes while
  // the listing reads still reaches the list, and counts as seen like the rest of that listing.
  const old: ChatSummary = {
    ...summary,
    target: { ...target, conversationId: 'old' },
    activity: { state: 'idle', at: '2026-01-02T00:00:00Z' },
  };
  const older = Promise.withResolvers<void>();
  let reading = false;
  f.answers.set('listChats', async (input: ChatInput<'listChats'>) => {
    if (!input.cursor) return { conversations: [summary], nextCursor: 'older' };
    reading = true;
    await older.promise;
    return { conversations: [{ ...old, title: 'Read before it changed' }], nextCursor: null };
  });
  await f.start();
  await f.connect();
  await waitFor(() => reading);
  for (const watch of f.chatLists)
    watch.receive(page([summary], [{ ...old, title: 'Changed while listing' }]));
  older.resolve();
  let state = await until(f, (s) => s.chats.length === 2);
  assert.equal(state.chats[1]!.title, 'Changed while listing');
  assert.deepEqual(groupChatsByActivity({ chats: state.chats, seen: state.seen }).ready, []);
  f.answers.delete('listChats');
  await turn();
  const listed = listings(f);
  const open = () => {
    const watches = f.chatLists.filter((watch) => !watch.closed);
    assert.equal(watches.length, 1);
    return watches[0]!;
  };
  const first = open();
  const other: ChatSummary = {
    ...summary,
    target: { ...target, conversationId: 'other' },
    title: 'Made by another client',
  };
  first.receive(page([other, summary]));
  state = await until(f, (s) => s.chats.length === 3);
  assert.deepEqual(
    state.chats.map((chat) => chat.target.conversationId),
    ['other', target.conversationId, 'old'],
  );
  // A changed chat past the first page replaces its row on screen without listing.
  first.receive(page([other], [{ ...summary, title: 'Changed past the page' }]));
  state = await until(f, (s) => s.chats[1]!.title === 'Changed past the page');
  assert.deepEqual(
    state.chats.map((chat) => chat.title),
    ['Made by another client', 'Changed past the page', 'Changed while listing'],
  );
  assert.equal(listings(f), listed);
  // A reload that read before a watch page lands after it: the newer page still wins.
  const reply = Promise.withResolvers<void>();
  f.answers.set('listChats', async () => {
    await reply.promise;
    return { conversations: [{ ...other, title: 'Stale' }, summary], nextCursor: null };
  });
  const reloading = f.reloadChats();
  await waitFor(() => listings(f) === listed + 1);
  first.receive(page([{ ...other, title: 'Fresh' }, summary]));
  await until(f, (s) => s.chats[0]!.title === 'Fresh');
  reply.resolve();
  await reloading;
  f.answers.delete('listChats');
  assert.equal((await f.state()).chats[0]!.title, 'Fresh');
  // A reset may have missed changes past the first page, so the list is read again.
  first.receive({ ...page([other, summary]), reset: true });
  await waitFor(() => listings(f) === listed + 2);
  // So may changed chats the watch let go of.
  first.receive(page([other, summary], [], 1));
  await waitFor(() => listings(f) === listed + 3);
  // A dropped watch watches again after its backoff and lists once it delivers.
  first.fail(unavailable());
  await waitFor(() => f.chatLists.at(-1) !== first);
  assert.equal(first.closed, true);
  const second = open();
  second.receive(page([summary, other]));
  await waitFor(() => listings(f) === listed + 4);
  // A refused watch stops; becoming visible watches again, and an open one is left alone.
  second.fail(new IncompatibleHostError({ reason: 'not-served' }));
  await waitFor(() => second.closed);
  const watches = f.chatLists.length;
  await f.watchChats();
  await f.watchChats();
  assert.equal(f.chatLists.length, watches + 1);
  const third = open();
  await f.disconnect();
  assert.equal(third.closed, true);
});
