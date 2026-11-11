import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { Layer, ManagedRuntime } from 'effect';
const runtime = ManagedRuntime.make(Layer.empty);
after(() => runtime.dispose());
import {
  maximumChatInputBytes,
  maximumChatReplyBytes,
  type ChatClient,
  type ChatSnapshot,
} from '@moonbase/contracts/chat';
import type { ConnectionClient } from '@moonbase/contracts/connection';
import { ApplicationError } from '@moonbase/contracts/workspace';
import { ChatIpcSession } from '../src/chat/session.ts';
import { browserClients, type ChatBridge, type Reply } from '../src/chat/wire.ts';
const context = { host: { hostId: 'host', storeId: 'store' }, actorId: 'owner' },
  target = { ...context, conversationId: 'saved' };
function fixture() {
  const inputs: unknown[] = [];
  let calls = 0,
    observers = 0,
    stop = 0;
  const chat: ChatClient = {
    watchChatList: () => async () => {},
    command: async (_op, _input, options) => {
      calls++;
      inputs.push(_input);
      if (_op === 'sendChat')
        throw new ApplicationError({ code: 'Uncertain', message: 'Admission response lost' });
      if (_op === 'getChatHistory')
        return await new Promise((_resolve, reject) =>
          options?.signal?.addEventListener(
            'abort',
            () => reject(new ApplicationError({ code: 'Cancelled', message: 'Wait cancelled' })),
            { once: true },
          ),
        );
      return null as never;
    },
    watch: () => {
      observers++;
      return async () => {
        observers--;
      };
    },
  };
  const connection: ConnectionClient = {
    command: async () => {
      stop++;
      return undefined as never;
    },
    watch: () => async () => {},
  };
  const owner = new ChatIpcSession(
    runtime,
    chat,
    { mode: 'remote', connection },
    context,
    () => {},
  );
  return {
    owner,
    inputs,
    get calls() {
      return calls;
    },
    get observers() {
      return observers;
    },
    get stop() {
      return stop;
    },
  };
}
test('IPC rejects unknown fields/operations/foreign authority before dispatch', async () => {
  const f = fixture();
  for (const args of [
    ['chat', 'unknown', {}],
    ['chat', 'constructor', {}],
    ['chat', '__proto__', {}],
    ['connection', 'constructor', {}],
    ['chat', 'getChat', { target, privateKey: 'x' }],
    ['chat', 'getChat', { target: { ...target, actorId: 'other' } }],
    ['chat', 'getChat', { target: { ...target, host: { ...context.host, storeId: 'other' } } }],
    [
      'chat',
      'getChatTranscriptContent',
      { source: { kind: 'entry', target: { ...target, actorId: 'other' }, entryId: 'entry' } },
    ],
    [
      'chat',
      'getChatTranscriptContent',
      {
        source: {
          kind: 'entry',
          target: { ...target, host: { ...context.host, storeId: 'other' } },
          entryId: 'entry',
        },
      },
    ],
    ['chat', 'getChatHistoryAround', { target: { ...target, actorId: 'other' }, entryId: 'entry' }],
    ['chat', 'findChatTranscript', { target: { ...target, actorId: 'other' }, query: 'literal' }],
    ['chat', 'findChatTranscript', { target, query: 'x'.repeat(1025) }],
    ['connection', 'connect', { profileId: 'id', destination: 'injected' }],
    ['unknown', 'getChat', { target }],
  ])
    await assert.rejects(f.owner.call(args[0], args[1], args[2], 'id'));
  assert.equal(f.calls, 0);
  assert.equal(f.stop, 0);
});
test('public bridge preserves Uncertain and exact pending payload; preaborted calls do not dispatch', async () => {
  const f = fixture();
  const bridge: ChatBridge = {
    context: async () => context,
    call: (kind, op, input, id) => f.owner.call(kind, op, input, id),
    cancel: (id) => f.owner.cancel(id),
    events: () => () => {},
  };
  const client = browserClients(bridge).chat,
    input = { target, requestId: 'original', text: 'captured' };
  await assert.rejects(client.command('sendChat', input), { code: 'Uncertain' });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(client.command('sendChat', input, { signal: abort.signal }), {
    code: 'Cancelled',
  });
  assert.equal(f.calls, 1);
  await f.owner.dispose();
});
test('provider browser replies project private fields and reject malformed status', async () => {
  let value: unknown = { providers: [], flow: null, privateToken: 'private-token' };
  const client = browserClients(
    {
      context: async () => context,
      call: async (kind, operation, input, _id, backendId) => {
        assert.equal(kind, 'providers');
        assert.equal(operation, 'getProviders');
        assert.equal(backendId, 'local');
        assert.deepEqual(input, {});
        return { ok: true, value };
      },
      cancel: async () => ({ ok: true, value: null }),
      events: () => () => {},
    },
    'local',
  ).providers;
  assert.deepEqual(await client.command('getProviders', {}), { providers: [], flow: null });
  value = { providers: [], flow: { id: 'incomplete' } };
  await assert.rejects(client.command('getProviders', {}), { code: 'Incompatible' });
});
// Main's ChatClient is a Pi runtime service; its own tests reject oversized and malformed replies.
test('renderer chat transport forwards main replies and snapshots without decoding them again', async () => {
  const value = { padding: 'x'.repeat(maximumChatReplyBytes) };
  let event: (id: string, result: Reply) => void = () => {},
    watchId = '';
  const client = browserClients({
    context: async () => context,
    call: async (kind, _operation, _input, id) => {
      if (kind === 'watch-chat') watchId = id;
      return { ok: true, value: kind === 'watch-chat' ? null : value };
    },
    cancel: async () => ({ ok: true, value: null }),
    events: (receive) => {
      event = receive;
      return () => {};
    },
  }).chat;
  const received: unknown[] = [];
  const close = client.watch({ target }, (next) => received.push(next), assert.fail);
  assert.deepEqual(await client.command('getChat', { target }), value);
  event(watchId, { ok: true, value });
  assert.deepEqual(received, [value]);
  await close();
});
test('local provider waits use the shared document lifetime without a remote connection', async (t) => {
  const started = Promise.withResolvers<AbortSignal>();
  const owner = new ChatIpcSession(
    runtime,
    {
      command: async () => null as never,
      watch: () => async () => {},
      watchChatList: () => async () => {},
    },
    { mode: 'local' },
    context,
    () => {},
    {
      providers: {
        watch: () => async () => {},
        command: async (_operation, _input, options) => {
          assert(options?.signal);
          const signal = options.signal;
          started.resolve(signal);
          return new Promise<never>((_resolve, reject) =>
            signal.addEventListener(
              'abort',
              () => reject(new ApplicationError({ code: 'Cancelled', message: 'Wait cancelled' })),
              { once: true },
            ),
          );
        },
      },
    },
  );
  t.after(() => owner.dispose());
  const pending = owner.call('providers', 'getProviders', {}, 'setup');
  const signal = await started.promise;
  await owner.dispose();
  const reply = await pending;
  assert(signal.aborted);
  assert(!reply.ok && reply.error.code === 'Cancelled');
  assert.equal(owner.count, 0);
});
test('desktop bridge admits maximum escaped chat text and still rejects oversized input before dispatch', async () => {
  const f = fixture();
  const client = browserClients({
    context: async () => context,
    call: (kind, op, input, id) => f.owner.call(kind, op, input, id),
    cancel: (id) => f.owner.cancel(id),
    events: () => () => {},
  }).chat;
  try {
    for (const escaped of ['\n', '\\', '\u0001']) {
      const input = {
        target,
        requestId: 'escaped',
        text: 'x' + escaped.repeat(maximumChatInputBytes - 1),
      };
      assert.equal(Buffer.byteLength(input.text), maximumChatInputBytes);
      assert(JSON.stringify(input).length > 65536);
      // The controlled service reports Uncertain only after dispatch.
      await assert.rejects(client.command('sendChat', input), { code: 'Uncertain' });
      assert.deepEqual(f.inputs.at(-1), input);
      const calls = f.calls;
      await assert.rejects(client.command('sendChat', { ...input, text: input.text + 'x' }), {
        code: 'InvalidInput',
      });
      assert.equal(f.calls, calls);
    }
    assert.equal(f.calls, 3);
    await assert.rejects(
      client.command('sendChat', { target, requestId: 'oversized', text: 'x'.repeat(256 * 1024) }),
      { code: 'InvalidInput' },
    );
    assert.equal(f.calls, 3);
  } finally {
    await f.owner.dispose();
  }
});
test('shared IPC schemas reject malformed nested data before dispatch and retain authority errors', async () => {
  const f = fixture();
  for (const input of [
    { target, requestId: 'send', text: 1 },
    { target: { ...target, extra: 'private' }, requestId: 'send', text: 'message' },
    { target, requestId: 'send', text: 'x'.repeat(32769) },
  ])
    await assert.rejects(f.owner.call('chat', 'sendChat', input, 'id'), { code: 'InvalidInput' });
  await assert.rejects(
    f.owner.call('chat', 'getChat', { target: { ...target, actorId: 'other' } }, 'id'),
    { code: 'Unauthorized' },
  );
  await assert.rejects(
    f.owner.call('watch-chat', '', { target: { ...target, extra: 'private' } }, 'id'),
    { code: 'InvalidInput' },
  );
  assert.equal(f.calls, 0);
  assert.equal(f.observers, 0);
  assert.equal(f.owner.count, 0);
  await f.owner.dispose();
});
test('IPC cancellation/disposal releases only owned waiters/observations, never Stop or Disconnect', async () => {
  const f = fixture();
  await f.owner.call('watch-chat', '', { target }, 'watch');
  assert.equal(f.observers, 1);
  const pending = f.owner.call('chat', 'getChatHistory', { target, cursor: 'page' }, 'wait');
  await f.owner.cancel('wait');
  const reply = await pending;
  assert(!reply.ok);
  assert.equal(reply.error.code, 'Cancelled');
  await f.owner.dispose();
  assert.equal(f.observers, 0);
  assert.equal(f.owner.count, 0);
  assert.equal(f.stop, 0);
});

test('chat cancellation waits for finalizers, fences callbacks and leaves commands responsive', async () => {
  const held = Promise.withResolvers<void>();
  let receive!: (value: ChatSnapshot) => void,
    emitted = 0,
    closes = 0;
  const chat: ChatClient = {
    watchChatList: () => async () => {},
    command: async () => null as never,
    watch: (_input, next) => {
      receive = next;
      return async () => {
        closes++;
        await held.promise;
      };
    },
  };
  const connection: ConnectionClient = {
    command: async () => undefined as never,
    watch: () => async () => {},
  };
  const owner = new ChatIpcSession(
    runtime,
    chat,
    { mode: 'remote', connection },
    context,
    () => emitted++,
  );
  await owner.call('watch-chat', '', { target }, 'watch');
  let done = false;
  const cleanup = owner.cancel('watch');
  assert.equal(owner.cancel('watch'), cleanup);
  void cleanup.then(() => {
    done = true;
  });
  receive({} as never);
  await Promise.resolve();
  assert.equal(done, false);
  assert.equal(emitted, 0);
  assert((await owner.call('connection', 'getConnection', {}, 'other')).ok);
  held.reject(new ApplicationError({ code: 'Persistence', message: 'watch release failed' }));
  const result = await cleanup;
  assert(!result.ok);
  assert.equal(result.error.code, 'Persistence');
  assert.equal(await owner.cancel('watch'), result);
  assert.equal(closes, 1);
  await assert.rejects(owner.dispose(), { code: 'Persistence' });
});

for (const failure of ['none', 'release', 'acquisition'] as const) {
  test(`reentrant chat watch cancellation joins the acquired close (${failure})`, async () => {
    const releasing = Promise.withResolvers<void>(),
      gate = Promise.withResolvers<void>();
    let acknowledgment: ReturnType<ChatIpcSession['cancel']> | undefined,
      releases = 0,
      delivered = 0;
    const expected = new ApplicationError({
      code: 'Persistence',
      message: 'Owned reentrant chat watch failure',
    });
    const chat: ChatClient = {
      watchChatList: () => async () => {},
      command: async () => null as never,
      watch: (_input, receive) => {
        receive({} as never);
        if (failure === 'acquisition') throw expected;
        receive({} as never);
        return async () => {
          releases++;
          releasing.resolve();
          await gate.promise;
        };
      },
    };
    const connection: ConnectionClient = {
      command: async () => undefined as never,
      watch: () => async () => {},
    };
    const owner = new ChatIpcSession(runtime, chat, { mode: 'remote', connection }, context, () => {
      delivered++;
      acknowledgment = owner.cancel('watch');
    });
    const watching = owner.call('watch-chat', '', { target }, 'watch');
    assert(acknowledgment);
    let settled = false;
    void acknowledgment.then(() => {
      settled = true;
    });
    if (failure !== 'acquisition') {
      await releasing.promise;
      assert.equal(settled, false);
      assert.equal(releases, 1);
      if (failure === 'release') gate.reject(expected);
      else gate.resolve();
    }
    const reply = await acknowledgment;
    const watchReply = await watching;
    assert.equal(reply.ok, failure === 'none');
    assert.equal(watchReply.ok, failure === 'none');
    assert.equal(delivered, 1);
    if (failure === 'none') await owner.dispose();
    else {
      assert(!reply.ok);
      assert.equal(reply.error.code, 'Persistence');
      await assert.rejects(owner.dispose(), { code: 'Persistence' });
    }
  });
}

test('local IPC captures its command and cannot route a late reply to a replacement document', async () => {
  const gate = Promise.withResolvers<void>();
  const chat: ChatClient = {
    watchChatList: () => async () => {},
    command: async () => {
      await gate.promise;
      return null as never;
    },
    watch: () => async () => {},
  };
  const owner = new ChatIpcSession(runtime, chat, { mode: 'local' }, context, () => {});
  const missing = await owner.call(
    'chat',
    'createChat',
    { session: context, requestId: 'missing', title: 'Missing settings' },
    'missing',
  );
  assert(!missing.ok && missing.error.code === 'InvalidInput');
  const pending = owner.call(
    'chat',
    'createChat',
    {
      session: context,
      requestId: 'captured',
      title: 'Local',
      settings: { cwd: '/approved', model: { provider: 'openai', modelId: 'test' } },
    },
    'captured',
  );
  const release = owner.dispose();
  gate.resolve();
  await pending;
  await release;
  assert.equal(owner.count, 0);
  await owner.dispose();
});

test('browser chat observation preserves reconnect status and document release fences late snapshots', async () => {
  const ready = Promise.withResolvers<void>();
  let receive!: (snapshot: ChatSnapshot) => void;
  let event: Parameters<ChatBridge['events']>[0] = () => {},
    releases = 0;
  const chat: ChatClient = {
    watchChatList: () => async () => {},
    command: async () => null as never,
    watch: (_input, next) => {
      receive = next;
      ready.resolve();
      return async () => {
        releases++;
      };
    },
  };
  const connection: ConnectionClient = {
    command: async () => undefined as never,
    watch: () => async () => {},
  };
  const owner = new ChatIpcSession(
    runtime,
    chat,
    { mode: 'remote', connection },
    context,
    (id, value) => event(id, value),
  );
  const client = browserClients({
    context: async () => context,
    call: (kind, op, input, id) => owner.call(kind, op, input, id),
    cancel: (id) => owner.cancel(id),
    events: (next) => {
      event = next;
      return () => {
        event = () => {};
      };
    },
  }).chat;
  const views: ChatSnapshot[] = [],
    errors: ApplicationError[] = [];
  const close = client.watch(
    { target },
    (value) => views.push(value),
    (error) => errors.push(error),
  );
  await ready.promise;
  const snapshot: ChatSnapshot = {
    conversation: {
      target,
      title: 'Selected',
      createdAt: '2026-11-04T00:00:00Z',
      cwd: '/remote',
      model: 'faux',
    },
    entries: [],
    olderCursor: null,
    run: null,
    state: 'idle',
    observationStatus: 'reconnecting',
    transcriptBoundary: null,
  };
  receive(snapshot);
  assert.equal(views[0].observationStatus, 'reconnecting');
  await owner.dispose();
  receive({ ...snapshot, observationStatus: 'connected' });
  assert.equal(views.length, 1);
  assert.equal(releases, 1);
  assert.deepEqual(errors, []);
  await close();
  await owner.dispose();
});
test('chat list and provider watches reach the renderer through main, scoped to the configured session', async () => {
  const lists: ((update: unknown) => void)[] = [],
    states: ((state: unknown) => void)[] = [];
  let closed = 0;
  const listeners = new Set<(id: string, result: Reply, backendId: string) => void>();
  const owner = new ChatIpcSession(
    runtime,
    {
      command: async () => null as never,
      watch: () => async () => {},
      watchChatList: (_input, receive) => {
        lists.push(receive as never);
        return async () => void closed++;
      },
    },
    { mode: 'local' },
    context,
    (id, result) => listeners.forEach((receive) => receive(id, result, 'local')),
    {
      providers: {
        command: async () => null as never,
        watch: (receive) => {
          states.push(receive as never);
          return async () => void closed++;
        },
      },
    },
  );
  const bridge: ChatBridge = {
    context: async () => context,
    call: (kind, operation, input, id) => owner.call(kind, operation, input, id),
    cancel: (id) => owner.cancel(id),
    events: (receive) => {
      listeners.add(receive);
      return () => void listeners.delete(receive);
    },
  };
  const clients = browserClients(bridge, 'local');
  const turn = () => new Promise((resolve) => setTimeout(resolve, 1));
  // A list watch for another actor is refused before it reaches the chat client.
  const refused: string[] = [];
  const other = clients.chat.watchChatList(
    { session: { ...context, actorId: 'someone-else' } },
    () => assert.fail('A foreign list reached the renderer.'),
    (error) => refused.push(error.code),
  );
  const listed: unknown[] = [],
    provided: unknown[] = [];
  const closeList = clients.chat.watchChatList(
    { session: context },
    (update) => listed.push(update),
    assert.fail,
  );
  const closeProviders = clients.providers.watch((state) => provided.push(state), assert.fail);
  while (!lists.length || !states.length || !refused.length) await turn();
  const update = { list: { conversations: [], nextCursor: null }, reset: false },
    state = { providers: [], flow: null };
  lists[0]!(update);
  states[0]!(state);
  assert.deepEqual([listed, provided, refused], [[update], [state], ['Unauthorized']]);
  await Promise.all([closeList(), closeProviders(), other().catch(() => {})]);
  assert.equal(closed, 2);
  await owner.dispose();
});
