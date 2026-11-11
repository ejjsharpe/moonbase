import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Effect, Exit, Layer, ManagedRuntime, Queue, Scope, Stream } from 'effect';
import type { ChatClient, ChatListUpdate, ChatSnapshot } from '@moonbase/contracts/chat';
import type { ConnectionSnapshot } from '@moonbase/contracts/connection';
import { ConnectionService, type VerifiedChatEndpoint } from '@moonbase/contracts/services';
import { ApplicationError } from '@moonbase/contracts/errors';
import { makeChatClient } from '@moonbase/application/runtime/clients';
import { RemoteChatLive, RemoteLocalHostLive } from '../src/remote.ts';
import { serveChat } from '../src/server.ts';
import * as P from '../src/protocol.ts';
import { fixture as runtimeFixture, session, until } from './runtime-fixture.ts';

/** A daemon over a fixed-settings runtime that can stop and start again on its port. */
async function daemon(t: TestContext) {
  const f = await runtimeFixture(t);
  const token = P.nonce(),
    listed: string[] = [];
  let connections = 0,
    scope: Scope.Closeable | undefined,
    port = 0;
  // Counts list commands, so a test sees that watches never poll.
  const client: ChatClient = {
    ...f.client,
    command: (operation, input, options) => {
      if (operation === 'listChats') listed.push(operation);
      return f.client.command(operation, input, options);
    },
  };
  const start = async () => {
    scope = Effect.runSync(Scope.make());
    const server = await Effect.runPromise(
      serveChat({ host: session.host, token, port }, client, undefined, [], {
        sources: {
          trackConnection: () => {
            connections++;
            return () => {};
          },
        },
      }).pipe(Effect.provideService(Scope.Scope, scope)),
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
    endpoint: (): VerifiedChatEndpoint => ({
      origin: `http://127.0.0.1:${port}`,
      token,
      expected: session.host,
      connectionId: 'one',
      health: { ...session.host, protocol: 2, version: '0.1.0', capabilities: [] },
    }),
  };
}
/** A remote client of `d`, over a connection whose endpoint the test may replace. */
function remote(t: TestContext, d: Awaited<ReturnType<typeof daemon>>) {
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
    Layer.mergeAll(RemoteChatLive, RemoteLocalHostLive).pipe(Layer.provide(connection)),
  );
  t.after(() => runtime.dispose());
  return {
    chat: makeChatClient(runtime),
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

test('one client shares one socket, and a chat another client creates reaches its list without listing', async (t) => {
  const d = await daemon(t);
  const a = remote(t, d),
    b = remote(t, d);
  const list = record<ChatListUpdate>();
  const close = b.chat.watchChatList({ session }, list.receive, list.fail);
  t.after(() => close().catch(() => {}));
  await until(async () => list.values.length, Boolean);
  assert.deepEqual(list.values[0], { list: { conversations: [], nextCursor: null }, reset: false });
  const created = await a.chat.command('createChat', {
    session,
    requestId: 'create',
    title: 'From another client',
  });
  const chat = record<ChatSnapshot>();
  const closeChat = a.chat.watch({ target: created.conversation.target }, chat.receive, chat.fail);
  t.after(() => closeChat().catch(() => {}));
  await until(
    async () => list.values.at(-1)!.list.conversations,
    (rows) => rows.some((row) => row.title === 'From another client'),
  );
  await until(async () => chat.values.length, Boolean);
  assert.equal(chat.values[0]!.observationStatus, 'connected');
  // A request, a chat watch and a list watch from one client share its one socket.
  assert.equal(d.connections, 2);
  assert.deepEqual(d.listed, []);
  assert.deepEqual([...list.errors, ...chat.errors], []);
});

test('a dropped daemon shows reconnecting, then resets its watches; a lost budget or generation fails them', async (t) => {
  const d = await daemon(t);
  const client = remote(t, d);
  const target = (
    await client.chat.command('createChat', { session, requestId: 'create', title: 'Kept' })
  ).conversation.target;
  const chat = record<ChatSnapshot>(),
    list = record<ChatListUpdate>();
  const closeChat = client.chat.watch({ target }, chat.receive, chat.fail);
  t.after(() => closeChat().catch(() => {}));
  const closeList = client.chat.watchChatList({ session }, list.receive, list.fail);
  t.after(() => closeList().catch(() => {}));
  await until(async () => chat.values.length && list.values.length, Boolean);
  // While the daemon is gone the last snapshot reads as reconnecting; nothing fails.
  await d.stop();
  await until(
    async () => chat.values.at(-1)!.observationStatus,
    (status) => status === 'reconnecting',
  );
  await d.start();
  // The restarted daemon kept no deltas, so both watches reset from fresh snapshots.
  await until(
    async () => chat.values.at(-1)!.observationStatus,
    (status) => status === 'connected',
  );
  await until(async () => list.values.at(-1)!.reset, Boolean);
  assert.deepEqual([...chat.errors, ...list.errors], []);
  // Three failed reconnects in one outage end the watch.
  await d.stop();
  await until(async () => chat.errors.length, Boolean);
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
