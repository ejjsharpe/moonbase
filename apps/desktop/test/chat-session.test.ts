import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { Layer, ManagedRuntime } from 'effect';
const runtime = ManagedRuntime.make(Layer.empty);
after(() => runtime.dispose());
import type { ChatClient, ChatSnapshot } from '@moonbase/contracts/chat';
import type { ConnectionClient } from '@moonbase/contracts/connection';
import { ApplicationError } from '@moonbase/contracts/workspace';
import { ChatIpcSession } from '../src/chat/session.ts';
import { browserClients, type ChatBridge } from '../src/chat/wire.ts';
const context = { host: { hostId: 'host', storeId: 'store' }, actorId: 'owner' },
  target = { ...context, conversationId: 'saved' };
function fixture() {
  let calls = 0,
    observers = 0,
    stop = 0;
  const chat: ChatClient = {
    command: async (_op, _input, options) => {
      calls++;
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
  const owner = new ChatIpcSession(runtime, chat, connection, context, () => {});
  return {
    owner,
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
  const owner = new ChatIpcSession(runtime, chat, connection, context, () => emitted++);
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
    const owner = new ChatIpcSession(runtime, chat, connection, context, () => {
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
