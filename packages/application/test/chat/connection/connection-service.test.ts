import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UnauthorizedError } from '@moonbase/contracts/errors';
import { ConnectionError } from '@moonbase/contracts/connection-errors';
import {
  chatFixture,
  connected,
  context,
  openChat,
  profile,
  providerPort,
  running,
  settings,
  summary,
  turn,
  unavailable,
  until,
  waitFor,
} from '../chat-fixture.ts';

const disconnected = { state: 'disconnected' as const, connectionId: null, profile };
const mutations = ['createChat', 'sendChat', 'stopChat'];

test('a host over a connection waits for an explicit Connect, then reads its providers and needs settings for a new chat', async (t) => {
  const providers = providerPort(() => ({ providers: [], flow: null }));
  const f = await chatFixture(t, { dependencies: { providers: providers.port } });
  await f.start();
  let state = await f.state();
  assert.equal(state.remote, true);
  assert.equal(state.ready, false);
  // Nothing reaches the host until the user connects.
  assert.equal(f.count('getChatHost'), 0);
  assert.equal(providers.calls.length, 0);
  await f.setDraft('Remote first message');
  await f.send(settings);
  assert.equal(f.count('createChat'), 0);
  assert.ok((await f.state()).error);
  await f.connect();
  await until(f, (s) => s.ready);
  // The verified host's providers are read, so its models can be chosen.
  await waitFor(() => providers.calls.length === 1);
  assert.equal(providers.calls[0]!.operation, 'getProviders');
  // Every host needs a new chat's settings.
  await f.send();
  assert.equal(f.count('createChat'), 0);
  const chosen = { cwd: '/host/projects/site', model: { provider: 'configured', modelId: 'm' } };
  await f.send(chosen);
  assert.deepEqual(
    (f.calls.find((call) => call.operation === 'createChat')!.input as { settings: unknown })
      .settings,
    chosen,
  );
  await f.disconnect();
  state = await f.state();
  assert.equal(state.ready, false);
});

test('a repeated Start keeps the open chat, its transcript and its watch', async (t) => {
  // The shell starts chat whenever a chat view shows, so a repeated start must not read it again.
  const f = await chatFixture(t);
  await openChat(f);
  const before = await f.state();
  const reads = f.count('getChat');
  await f.start();
  await turn();
  const after = await f.state();
  assert.equal(after.snapshot, before.snapshot);
  assert.equal(after.transcript, before.transcript);
  assert.equal(after.ready, true);
  assert.equal(f.subscriptions, 1);
  assert.equal(f.count('getChat'), reads);
  f.publish(running());
  await until(f, (state) => state.snapshot?.state === 'running');
});

test('a newer Refresh replaces a running one, whose held listing never lands', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  const held = Promise.withResolvers<void>();
  f.answers.set('listChats', async () => {
    await held.promise;
    return { conversations: [{ ...summary, title: 'Obsolete' }], nextCursor: null };
  });
  const lists = f.count('listChats');
  const obsolete = f.refresh();
  await waitFor(() => f.count('listChats') === lists + 1);
  f.answers.delete('listChats');
  await f.refresh();
  assert.equal(f.signals.get('listChats')!.at(-2)!.aborted, true);
  held.resolve();
  await obsolete;
  const state = await f.state();
  assert.equal(state.chats[0]!.title, 'Saved');
  assert.ok(state.snapshot);
  assert.equal(state.error, null);
  assert.equal(f.subscriptions, 1);
});

test('Stop runs beside a held Refresh, and Disconnect ends the Refresh before it lands', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  const held = Promise.withResolvers<void>();
  f.answers.set('listChats', async () => {
    await held.promise;
    return { conversations: [], nextCursor: null };
  });
  const lists = f.count('listChats');
  const refreshing = f.refresh();
  await waitFor(() => f.count('listChats') === lists + 1);
  f.publish(running());
  await until(f, (state) => !!state.snapshot?.run);
  await f.stop();
  assert.equal(f.count('stopChat'), 1);
  await f.disconnect();
  assert.equal(f.signals.get('listChats')!.at(-1)!.aborted, true);
  held.resolve();
  await refreshing;
  const state = await f.state();
  assert.equal(f.count('listChats'), lists + 1);
  assert.equal(state.host, null);
  assert.equal(state.snapshot, null);
  assert.equal(state.chats.length, 1);
  assert.equal(f.subscriptions, 0);
});

test('a new connection generation cancels a held host read and never takes the old host', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  const held = Promise.withResolvers<void>();
  f.answers.set('getChatHost', async () => {
    await held.promise;
    return { ...context, actorId: 'obsolete', mode: 'local' };
  });
  const reads = f.count('getChatHost');
  const refreshing = f.refresh();
  await waitFor(() => f.count('getChatHost') === reads + 1);
  const old = f.signals.get('getChatHost')!.at(-1)!;
  f.answers.delete('getChatHost');
  f.publishConnection(connected('replacement'));
  await until(f, (s) => s.connection?.connectionId === 'replacement');
  assert(old.aborted);
  held.resolve();
  await refreshing;
  const state = await until(f, (s) => s.ready && !!s.snapshot);
  assert.equal(state.host!.actorId, context.actorId);
  assert.equal(state.error, null);
  assert.equal(f.subscriptions, 1);
  assert(!f.calls.some((call) => mutations.includes(call.operation)));
});

test('a connection state the watch delivers replaces an older status reply', async (t) => {
  const f = await chatFixture(t);
  const held = Promise.withResolvers<void>();
  f.answers.set('getConnection', async () => {
    await held.promise;
    return disconnected;
  });
  const starting = f.start();
  await waitFor(() => f.count('getConnection') === 1 && f.connectionWatches.length === 1);
  f.publishConnection(connected('newer-observed-generation'));
  await until(f, (s) => s.connection?.connectionId === 'newer-observed-generation');
  await f.refresh();
  held.resolve();
  await starting;
  const state = await until(f, (s) => s.ready);
  assert.equal(state.connection!.connectionId, 'newer-observed-generation');
  assert.ok(state.host);
  assert.equal(state.error, null);
  assert.equal(f.count('connect'), 0);
});

test('a held Connect reply cannot bring back a generation its watch already lost, but its failure shows', async (t) => {
  const f = await chatFixture(t);
  await f.start();
  const held = Promise.withResolvers<void>();
  const lost = connected('lost-generation');
  f.answers.set('connect', async () => {
    await held.promise;
    return lost;
  });
  const connecting = f.connect();
  await waitFor(() => f.count('connect') === 1);
  f.publishConnection(lost);
  f.publishConnection(disconnected);
  held.resolve();
  await connecting;
  await turn();
  let state = await f.state();
  assert.equal(state.connection!.state, 'disconnected');
  assert.equal(state.host, null);
  assert.equal(state.ready, false);
  assert.equal(state.error, null);

  // A refused Connect the watch overtook (it already showed `connecting`) still shows why.
  const refused = Promise.withResolvers<void>();
  f.answers.set('connect', async () => {
    await refused.promise;
    throw new UnauthorizedError({ operation: 'Connect' });
  });
  const retrying = f.connect();
  await waitFor(() => f.count('connect') === 2);
  f.publishConnection({ ...disconnected, state: 'connecting', connectionId: 'refused' });
  await until(f, (s) => s.connection?.state === 'connecting');
  refused.resolve();
  await retrying;
  state = await f.state();
  assert.ok(state.error);
});

test('Disconnect closes the chat’s watches before it disconnects, refusing a Send meanwhile', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  await waitFor(() => f.chatLists.some((watch) => !watch.closed));
  await f.setDraft('kept while disconnecting');
  const held = Promise.withResolvers<void>();
  let open: number | undefined;
  f.answers.set('disconnect', async () => {
    open = f.subscriptions + f.chatLists.filter((watch) => !watch.closed).length;
    await held.promise;
    f.publishConnection(disconnected);
  });
  const disconnecting = f.disconnect();
  await waitFor(() => f.count('disconnect') === 1);
  assert.equal(open, 0);
  await f.send();
  assert.equal(f.count('sendChat'), 0);
  held.resolve();
  await disconnecting;
  let state = await f.state();
  assert.equal(state.draft, 'kept while disconnecting');
  assert.equal(state.connection!.state, 'disconnected');
  assert.equal(state.ready, false);
  assert(!f.calls.some((call) => mutations.includes(call.operation)));
  // Connecting again watches the selected chat again.
  f.answers.delete('disconnect');
  await f.connect();
  state = await until(f, (s) => s.ready && !!s.snapshot);
  assert.equal(f.subscriptions, 1);
});

test('a held status read after Disconnect cannot replace a newer watched generation', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  const held = Promise.withResolvers<void>();
  f.answers.set('getConnection', async () => {
    await held.promise;
    return disconnected;
  });
  const disconnecting = f.disconnect();
  await waitFor(() => f.count('getConnection') === 2);
  f.publishConnection(connected('replacement-after-disconnect'));
  await until(f, (s) => s.connection?.connectionId === 'replacement-after-disconnect');
  await f.refresh();
  held.resolve();
  await disconnecting;
  const state = await until(f, (s) => s.ready);
  assert.equal(state.connection!.connectionId, 'replacement-after-disconnect');
  assert.ok(state.host);
});

test('a repeated Disconnect sends one disconnect, and its failure is shown', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  const held = Promise.withResolvers<void>();
  f.answers.set('disconnect', async () => {
    f.publishConnection(disconnected);
    await held.promise;
    throw unavailable();
  });
  const first = f.disconnect();
  await waitFor(() => f.count('disconnect') === 1);
  await f.disconnect();
  held.resolve();
  await first;
  assert.equal(f.count('disconnect'), 1);
  let state = await f.state();
  assert.ok(state.error);
  assert.equal(state.ready, false);

  // A held Disconnect a newer connection overtook is refused as stale, and shows nothing.
  await f.connect();
  await until(f, (s) => s.ready);
  const stale = Promise.withResolvers<void>();
  f.answers.set('disconnect', async () => {
    await stale.promise;
    throw new ConnectionError({ reason: 'stale-generation' });
  });
  const overtaken = f.disconnect();
  await waitFor(() => f.count('disconnect') === 2);
  f.publishConnection(connected('newer-generation'));
  await until(f, (s) => s.connection?.connectionId === 'newer-generation');
  stale.resolve();
  await overtaken;
  state = await until(f, (s) => s.ready);
  assert.equal(state.error, null);
});

test('closing the chat during its first status read cancels the read and starts nothing', async (t) => {
  const f = await chatFixture(t);
  const held = Promise.withResolvers<void>();
  f.answers.set('getConnection', async () => {
    await held.promise;
    return connected('late');
  });
  const starting = f.start();
  await waitFor(() => f.count('getConnection') === 1);
  await f.close();
  assert.equal(f.signals.get('getConnection')!.at(-1)!.aborted, true);
  held.resolve();
  await starting;
  await turn();
  assert.equal(f.count('getChatHost'), 0);
  assert.equal(f.storage.writes, 0);
});
