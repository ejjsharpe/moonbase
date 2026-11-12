import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Effect, Exit, Layer, ManagedRuntime, Queue, Scope, Stream } from 'effect';
import type { ChatClient, ChatListUpdate, ChatSnapshot } from '@moonbase/contracts/chat';
import type { ConnectionSnapshot } from '@moonbase/contracts/connection';
import {
  ConnectionService,
  WorkspaceHostService,
  type VerifiedChatEndpoint,
} from '@moonbase/contracts/services';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { DaemonClient } from '@moonbase/contracts/daemon';
import { chatHostCapabilities } from '@moonbase/contracts/host';
import { makeChatClient } from '@moonbase/application/runtime/clients';
import type { WorkspaceHostClient } from '@moonbase/contracts/workspace-host';
import {
  DaemonLinkClock,
  RemoteChatLive,
  RemoteLocalHostLive,
  RemoteWorkspaceHostLive,
} from '../src/remote.ts';
import { serveChat } from '../src/server.ts';
import * as P from '../src/protocol.ts';
import { fixture as runtimeFixture, manualClock, session, until } from './runtime-fixture.ts';

// The daemon serves chat; these cases need none of its other operations.
const unserved: DaemonClient = {
  command: async () => {
    throw new ApplicationError({ code: 'Unavailable', message: 'Not served here.' });
  },
};
/** A daemon over a local-mode runtime that can stop and start again on its port. */
async function daemon(t: TestContext, workspace?: WorkspaceHostClient) {
  const f = await runtimeFixture(t);
  const token = P.nonce(),
    listed: string[] = [];
  let connections = 0,
    listWatches = 0,
    scope: Scope.Closeable | undefined,
    port = 0;
  // Counts list commands, so a test sees that watches never poll.
  const client: ChatClient = {
    ...f.client,
    command: (operation, input, options) => {
      if (operation === 'listChats') listed.push(operation);
      return f.client.command(operation, input, options);
    },
    watchChatList: (input, receive, onError) => {
      listWatches++;
      return f.client.watchChatList(input, receive, onError);
    },
  };
  const start = async () => {
    scope = Effect.runSync(Scope.make());
    const server = await Effect.runPromise(
      serveChat(
        { host: session.host, token, port },
        client,
        unserved,
        [chatHostCapabilities.local],
        {
          ...(workspace ? { workspace } : {}),
          sources: {
            trackConnection: () => {
              connections++;
              return () => {};
            },
          },
        },
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    );
    port = Number(new URL(server.origin).port);
  };
  const stop = async () => {
    await Effect.runPromise(Scope.close(scope!, Exit.void));
    scope = undefined;
  };
  await start();
  t.after(async () => {
    if (scope) await stop();
  });
  return {
    f,
    token,
    listed,
    start,
    stop,
    get connections() {
      return connections;
    },
    get listWatches() {
      return listWatches;
    },
    endpoint: (): VerifiedChatEndpoint => ({
      origin: `http://127.0.0.1:${port}`,
      token,
      expected: session.host,
      connectionId: 'one',
      health: { ...session.host, protocol: 2, version: '0.1.0', capabilities: [] },
    }),
  };
}
/**
 * A remote client of `d`, over a connection whose endpoint the test may replace; its sockets and
 * reconnect backoff run on `clock` when one is given.
 */
function remote(
  t: TestContext,
  d: Awaited<ReturnType<typeof daemon>>,
  clock?: ReturnType<typeof manualClock>,
  withWorkspace = false,
) {
  let endpoint = d.endpoint();
  const changes = new Set<() => void>();
  const unavailable = () =>
    Effect.fail(new ApplicationError({ code: 'Unavailable', message: 'Not served here.' }));
  const connection = Layer.succeed(ConnectionService, {
    getConnection: unavailable,
    connect: unavailable,
    disconnect: unavailable,
    watch: () =>
      Stream.callback<ConnectionSnapshot>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const publish = () =>
              void Queue.offerUnsafe(queue, { state: 'disconnected', connectionId: null } as never);
            changes.add(publish);
            return publish;
          }),
          (publish) => Effect.sync(() => void changes.delete(publish)),
        ),
      ),
    endpoint: () => Effect.sync(() => structuredClone(endpoint)),
  });
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      RemoteChatLive,
      RemoteLocalHostLive,
      ...(withWorkspace ? [RemoteWorkspaceHostLive({ host: session.host })] : []),
    ).pipe(
      Layer.provide(
        clock ? Layer.merge(connection, Layer.succeed(DaemonLinkClock, clock)) : connection,
      ),
    ),
  );
  t.after(() => runtime.dispose());
  return {
    chat: makeChatClient(runtime),
    workspace: () => runtime.runPromise(WorkspaceHostService),
    /** Replaces the connection generation and announces it. */
    replace() {
      endpoint = { ...endpoint, connectionId: P.nonce() };
      for (const publish of changes) publish();
    },
  };
}
function record<A>() {
  const values: A[] = [],
    errors: ApplicationError[] = [];
  return {
    values,
    errors,
    receive: (value: A) => void values.push(value),
    fail: (error: ApplicationError) => void errors.push(error),
  };
}

test('one client shares one socket and one list watch, and chats another client creates or changes, past the first page too, reach its list without listing', async (t) => {
  const d = await daemon(t);
  const a = remote(t, d),
    b = remote(t, d);
  // Two windows of one client.
  const list = record<ChatListUpdate>(),
    other = record<ChatListUpdate>();
  const close = b.chat.watchChatList({ session }, list.receive, list.fail);
  t.after(() => close().catch(() => {}));
  await until(async () => list.values.length, Boolean);
  const closeOther = b.chat.watchChatList({ session }, other.receive, other.fail);
  t.after(() => closeOther().catch(() => {}));
  await until(async () => other.values.length, Boolean);
  const empty = { list: { conversations: [], nextCursor: null }, changed: [], dropped: 0 };
  assert.deepEqual(list.values[0], { ...empty, reset: false });
  assert.deepEqual(other.values[0], { ...empty, reset: false });
  const created = await a.chat.command('createChat', {
    session,
    requestId: 'create',
    title: 'From another client',
    settings: d.f.settings,
  });
  const target = created.conversation.target;
  const chat = record<ChatSnapshot>();
  const closeChat = a.chat.watch({ target }, chat.receive, chat.fail);
  t.after(() => closeChat().catch(() => {}));
  await until(
    async () => list.values.at(-1)!.list.conversations,
    (rows) => rows.some((row) => row.title === 'From another client'),
  );
  await until(async () => chat.values.length, Boolean);
  assert.equal(chat.values[0]!.observationStatus, 'connected');
  // A request, a chat watch and a list watch from one client share its one socket, and its two
  // windows' list watches share one subscription.
  assert.equal(d.connections, 2);
  assert.equal(d.listWatches, 1);
  // Once a full page of newer chats pushes it past the first page, settling it still reaches
  // the other client's list and the settling client's own.
  const own = record<ChatListUpdate>();
  const closeOwn = a.chat.watchChatList({ session }, own.receive, own.fail);
  t.after(() => closeOwn().catch(() => {}));
  for (let index = 0; index < 32; index++)
    await a.chat.command('createChat', {
      session,
      requestId: `newer-${index}`,
      title: 'Newer',
      settings: d.f.settings,
    });
  const pastPage = (update: ChatListUpdate | undefined) =>
    !!update &&
    !update.list.conversations.some((row) => row.target.conversationId === target.conversationId);
  await until(async () => list.values.at(-1), pastPage);
  await a.chat.command('settleChat', { target, settled: true });
  for (const watched of [list, own])
    await until(
      async () => watched.values.at(-1)!,
      (update) =>
        pastPage(update) &&
        update.changed.some(
          (row) => row.target.conversationId === target.conversationId && row.settledAt,
        ),
    );
  assert.deepEqual(d.listed, []);
  assert.deepEqual([...list.errors, ...other.errors, ...own.errors, ...chat.errors], []);
});

test('a dropped daemon shows reconnecting, then resets its watches; healthy traffic renews the budget, and a lost budget or generation fails them', async (t) => {
  const d = await daemon(t),
    clock = manualClock();
  const client = remote(t, d, clock);
  const target = (
    await client.chat.command('createChat', {
      session,
      requestId: 'create',
      title: 'Kept',
      settings: d.f.settings,
    })
  ).conversation.target;
  const chat = record<ChatSnapshot>(),
    list = record<ChatListUpdate>();
  const closeChat = client.chat.watch({ target }, chat.receive, chat.fail);
  t.after(() => closeChat().catch(() => {}));
  const closeList = client.chat.watchChatList({ session }, list.receive, list.fail);
  t.after(() => closeList().catch(() => {}));
  await until(async () => chat.values.length && list.values.length, Boolean);
  /** Moves the clock past the longest backoff until `done`, so each pending reconnect runs. */
  const advanceUntil = <T>(get: () => T, done: (value: T) => boolean) =>
    until(async () => {
      clock.advance(P.streamLimits.reconnectMs.at(-1)!);
      return get();
    }, done);
  // More drops than the budget allows, each after a healthy period, keep reconnecting.
  for (let outage = 0; outage <= P.streamLimits.reconnectMs.length; outage++) {
    const lists = list.values.length;
    // While the daemon is gone the last snapshot reads as reconnecting; nothing fails.
    await d.stop();
    await until(
      async () => chat.values.at(-1)!.observationStatus,
      (status) => status === 'reconnecting',
    );
    await d.start();
    // The restarted daemon kept no deltas, so both watches reset from fresh snapshots.
    await advanceUntil(
      () => chat.values.at(-1)!.observationStatus,
      (status) => status === 'connected',
    );
    await advanceUntil(() => list.values.length > lists && list.values.at(-1)!.reset, Boolean);
    // Traffic `renewMs` after the reconnect proves the connection healthy.
    clock.advance(P.streamLimits.renewMs);
    await client.chat.command('listChats', { session });
  }
  assert.deepEqual([...chat.errors, ...list.errors], []);
  // Failed reconnects through the whole budget in one outage end the watch.
  await d.stop();
  await advanceUntil(() => chat.errors.length, Boolean);
  assert.equal(chat.errors[0]!.code, 'Unavailable');
  // A new connection generation ends a watch at once.
  await d.start();
  const again = record<ChatSnapshot>();
  const closeAgain = client.chat.watch({ target }, again.receive, again.fail);
  t.after(() => closeAgain().catch(() => {}));
  await until(async () => again.values.length, Boolean);
  client.replace();
  await until(async () => again.errors.length, Boolean);
  assert.equal(again.errors[0]!.code, 'Unavailable');
});

test('a workspace call or watch for another host is refused before it is sent, and a checkout of another host is refused when opened', async (t) => {
  const foreign = {
    vcs: 'none',
    hostId: 'other-host',
    checkoutId: 'checkout-1',
    projectId: 'project-1',
    root: '/work',
  } as const;
  const calls: string[] = [];
  const workspace: WorkspaceHostClient = {
    command: async (operation) => {
      calls.push(operation);
      return foreign as never;
    },
    watch: () => () => Promise.resolve(),
  };
  const d = await daemon(t, workspace);
  const host = await remote(t, d, undefined, true).workspace();
  const code = async (effect: Effect.Effect<unknown, { code: string }>) =>
    (await Effect.runPromise(Effect.flip(effect))).code;
  assert.equal(await code(host.readFile({ checkout: foreign, path: 'a.txt' })), 'Unauthorized');
  assert.equal(
    await code(Stream.runDrain(host.watch({ checkout: foreign, paths: [''] }))),
    'Unauthorized',
  );
  assert.deepEqual(calls, []);
  // The daemon answers an open with a checkout of another host.
  assert.equal(await code(host.openCheckout({ root: '/work' })), 'Incompatible');
  assert.deepEqual(calls, ['openCheckout']);
});
