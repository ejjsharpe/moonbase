import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Exit } from 'effect';
import { maximumChatInputBytes } from '@moonbase/contracts/chat';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { CheckoutTarget, EditorClient } from '@moonbase/contracts/workspace';
import { ipcLimits } from '../src/ipc/ipc-limits.ts';
import { makePortSocket } from '../src/ipc/port-socket.ts';
import { ChatIpcSession } from '../src/main/chat/session.ts';
import { toMessagePortLike } from '../src/renderer/ipc/desktop-ipc.ts';
import { makeIpcFixture, noChat, waitFor } from './fixtures/ipc-fixture.ts';
import { ManagedRuntime, Layer } from 'effect';

const target: CheckoutTarget = {
  hostId: 'local-host',
  checkoutId: 'checkout',
  projectId: 'project',
  root: '/approved',
  vcs: 'none',
};
const context = { host: { hostId: 'host', storeId: 'store' }, actorId: 'actor' };
/** A workspace whose reads wait until their request is cancelled, and whose watches stay open. */
function heldWorkspace() {
  const state = { reads: 0, cancelled: 0, watches: 0, closed: 0 };
  const client: EditorClient = {
    command: (_operation, _input, options) =>
      new Promise((_resolve, reject) => {
        state.reads++;
        options?.signal?.addEventListener('abort', () => {
          state.cancelled++;
          reject(new ApplicationError({ code: 'Cancelled', message: 'Cancelled' }));
        });
      }),
    watch: () => {
      state.watches++;
      return async () => void state.closed++;
    },
  };
  return { state, client };
}
const read = { checkout: target, path: 'a.ts' };

test('a port message over the length bound, or one that is not text, closes the connection unread', async () => {
  for (const message of ['x'.repeat(65), { not: 'text' }]) {
    const { port1, port2 } = new MessageChannel();
    const runtime = ManagedRuntime.make(Layer.empty);
    const received: unknown[] = [];
    const closed = Promise.withResolvers<void>();
    (port2 as unknown as NodeJS.EventEmitter).once('close', () => closed.resolve());
    port2.start();
    const reading = runtime.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const socket = yield* makePortSocket(Effect.succeed(toMessagePortLike(port1)), 64);
          const reader = yield* socket.reader;
          for (;;) received.push(...(yield* reader.pull));
        }),
      ),
    );
    port2.postMessage('x'.repeat(64));
    port2.postMessage(message);
    await closed.promise;
    assert(Exit.isFailure(await reading));
    assert.deepEqual(received, ['x'.repeat(64)]);
    await runtime.dispose();
  }
});

test('a document holds at most its connection limit, and a closed one frees its place', async () => {
  const f = await makeIpcFixture();
  try {
    const connections = Array.from({ length: ipcLimits.connections }, () => f.connectRaw());
    assert(connections.every(Boolean));
    assert.equal(f.connectRaw(), undefined);
    connections[0]!.close();
    await waitFor(() => {
      const connection = f.connectRaw();
      connection?.close();
      return !!connection;
    });
  } finally {
    await f.dispose();
  }
});

test('main refuses a frame it cannot read, an unknown procedure and an input its schema refuses, before dispatch', async () => {
  const workspace = heldWorkspace();
  const f = await makeIpcFixture({ editor: { client: workspace.client } });
  try {
    f.approvals.adoptCheckout(target);
    for (const [tag, payload] of [
      ['__proto__', {}],
      ['toString', {}],
      ['readFile', { checkout: target, path: 7 }],
      ['readFile', { checkout: { ...target, root: 'x'.repeat(4097) }, path: 'a.ts' }],
      ['loadRecovery', {}],
      // Exact shapes: a field no schema declares is refused, not dropped.
      ['loadRecovery', { clientId: 'desktop-primary', extra: true }],
      ['readFile', { checkout: { ...target, private: 'x' }, path: 'a.ts' }],
      // A cleanup failure's message is bounded and its code one Moonbase knows.
      ...[
        { _tag: 'ApplicationError', code: 'Persistence', message: 'x'.repeat(513) },
        { _tag: 'ApplicationError', code: 'Unknown', message: 'bad' },
        { _tag: 'ApplicationError', code: 'Persistence', message: 'bad', private: true },
      ].map((cleanupError) => ['answerQuit', { id: 'quit', consent: true, cleanupError }] as const),
    ] as const)
      assert.equal((await f.call(tag, payload)).error?._tag, 'Die', tag);
    const raw = f.connectRaw()!;
    raw.send('{not json');
    assert.equal((await raw.next())._tag, 'Defect');
    raw.close();
    assert.equal(workspace.state.reads, 0);
  } finally {
    await f.dispose();
  }
});

test('each kind runs at most its limit of requests and of watches at once, refusing more', async () => {
  const workspace = heldWorkspace();
  const sessions = new Map(
    (['local', 'remote'] as const).map((id) => [
      id,
      new ChatIpcSession(
        {
          command: (_operation, _input, options) =>
            workspace.client.command('readFile', read, options) as never,
          watch: () => async () => {},
          watchChatList: () => async () => {},
        },
        { mode: 'local' },
        context,
      ),
    ]),
  );
  const f = await makeIpcFixture({
    editor: { client: workspace.client },
    chat: {
      backends: {
        ...noChat,
        getTargets: () => [
          { id: 'local', label: 'Local', mode: 'local' },
          { id: 'remote', label: 'Remote', mode: 'remote' },
        ],
        getSession: (id) => sessions.get(id),
      },
    },
  });
  try {
    f.approvals.adoptCheckout(target);
    const raw = f.connectRaw()!;
    let id = 0;
    const send = (tag: string, payload: unknown) =>
      raw.send({ _tag: 'Request', id: String(id++), tag, payload, headers: [] });
    for (let index = 0; index < ipcLimits.editorRequests; index++) send('readFile', read);
    for (let index = 0; index < ipcLimits.editorRequests; index++)
      send('watchWorkspace', { checkout: target, paths: [] });
    const chatRead = { target: { ...context, conversationId: 'chat' } };
    for (const backendId of ['local', 'remote'])
      for (let index = 0; index < ipcLimits.chatRequests; index++)
        send('getChat', { backendId, input: chatRead });
    await waitFor(
      () =>
        workspace.state.reads === ipcLimits.editorRequests + 2 * ipcLimits.chatRequests &&
        workspace.state.watches === ipcLimits.editorRequests,
    );
    // The next of each kind is refused, not queued.
    const busy = { ok: false, error: { _tag: 'IpcBusyError', limit: 'requests' } };
    assert.deepEqual(await f.call('readFile', read), busy);
    assert.deepEqual(await f.call('getChat', { backendId: 'local', input: chatRead }), busy);
    assert.deepEqual(await f.call('watchWorkspace', { checkout: target, paths: [] }), {
      ok: false,
      error: { _tag: 'IpcBusyError', limit: 'watches' },
    });
    raw.close();
    // Closing the connection interrupts its requests and closes its watches.
    await waitFor(
      () =>
        workspace.state.cancelled === ipcLimits.editorRequests + 2 * ipcLimits.chatRequests &&
        workspace.state.closed === ipcLimits.editorRequests,
    );
  } finally {
    await f.dispose();
  }
});

test('the chat request size bound admits the largest escaped message', async () => {
  const sent: unknown[] = [];
  const session = new ChatIpcSession(
    {
      command: async (_operation, input) => {
        sent.push(input);
        throw new ApplicationError({ code: 'Uncertain', message: 'Admission reply lost' });
      },
      watch: () => async () => {},
      watchChatList: () => async () => {},
    },
    { mode: 'local' },
    context,
  );
  const f = await makeIpcFixture({
    chat: {
      backends: {
        ...noChat,
        getTargets: () => [{ id: 'local', label: 'Local', mode: 'local' }],
        getSession: () => session,
      },
    },
  });
  try {
    const chat = f.target('local').chat;
    const target = { ...context, conversationId: 'chat' };
    const input = {
      target,
      requestId: 'escaped',
      text: 'x' + '\u0001'.repeat(maximumChatInputBytes - 1),
    };
    await assert.rejects(chat.command('sendChat', input), { code: 'Uncertain' });
    assert.deepEqual(sent, [input]);
    assert.equal(sent.length, 1);
  } finally {
    await f.dispose();
  }
});

test('a handler’s defect reaches the renderer without its diagnostics, and an error’s message is bounded', async () => {
  const secret = '/Users/someone/private';
  let failure: unknown = Error(secret);
  const f = await makeIpcFixture({
    editor: {
      client: {
        command: async () => {
          throw failure;
        },
        watch: () => async () => {},
      },
    },
  });
  try {
    f.approvals.adoptCheckout(target);
    const defect = await f.call('readFile', read);
    assert.deepEqual(defect, {
      ok: false,
      error: {
        _tag: 'ApplicationError',
        code: 'Unavailable',
        message: 'Application effect failed',
      },
    });
    failure = new ApplicationError({ code: 'Persistence', message: 'x'.repeat(1000) });
    await assert.rejects(f.editor.command('readFile', read), (error: ApplicationError) => {
      assert.equal(error.code, 'Persistence');
      assert.equal(error.message.length, ipcLimits.errorMessageLength);
      return true;
    });
  } finally {
    await f.dispose();
  }
});

test('releasing a document interrupts its requests, closes its watches and connections, and refuses none after', async () => {
  const workspace = heldWorkspace();
  const f = await makeIpcFixture({ editor: { client: workspace.client } });
  try {
    f.approvals.adoptCheckout(target);
    const raw = f.connectRaw()!;
    const reading = f.editor.command('readFile', read);
    void reading.catch(() => {});
    f.editor.watch(
      { checkout: target, paths: [] },
      () => {},
      () => {},
    );
    await waitFor(() => workspace.state.reads === 1 && workspace.state.watches === 1);
    await f.releaseDocument();
    assert.equal(workspace.state.cancelled, 1);
    assert.equal(workspace.state.closed, 1);
    await raw.closed;
    await assert.rejects(reading);
    // The next document is served as usual.
    const next = f.editor.command('readFile', read);
    void next.catch(() => {});
    await waitFor(() => workspace.state.reads === 2);
  } finally {
    await f.dispose();
  }
  assert.equal(workspace.state.cancelled, 2);
  assert.equal(f.connectRaw(), undefined);
});
