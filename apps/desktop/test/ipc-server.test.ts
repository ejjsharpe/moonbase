import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Exit, Stream } from 'effect';
import { maximumChatInputBytes } from '@moonbase/contracts/chat';
import { UncertainError } from '@moonbase/contracts/errors';
import type { ChatServiceShape, WorkspaceServiceShape } from '@moonbase/contracts/services';
import { WorkspaceStoreError } from '@moonbase/contracts/workspace-host-errors';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { ipcLimits } from '../src/ipc/ipc-limits.ts';
import { makePortSocket } from '../src/ipc/port-socket.ts';
import { toMessagePortLike } from '../src/renderer/ipc/desktop-ipc.ts';
import { fakeChatTargets, makeIpcFixture, waitFor, watched } from './fixtures/ipc-fixture.ts';
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
  /** A request that waits until it is interrupted. */
  const held = Effect.andThen(
    Effect.sync(() => void state.reads++),
    Effect.onInterrupt(Effect.never, () => Effect.sync(() => void state.cancelled++)),
  );
  const workspace: Partial<WorkspaceServiceShape> = {
    readFile: () => held,
    watch: () =>
      watched(() => {
        state.watches++;
        return () => void state.closed++;
      }),
  };
  return { state, held, workspace };
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
    const connections = await Promise.all(
      Array.from({ length: ipcLimits.connections }, () => f.connectRaw()),
    );
    assert(connections.every(Boolean));
    assert.equal(await f.connectRaw(), undefined);
    connections[0]!.close();
    for (;;) {
      const connection = await f.connectRaw();
      connection?.close();
      if (connection) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  } finally {
    await f.dispose();
  }
});

test('main refuses a frame it cannot read, an unknown procedure and an input its schema refuses, before dispatch', async () => {
  const workspace = heldWorkspace();
  const f = await makeIpcFixture({ editor: { workspace: workspace.workspace } });
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
      // A cleanup failure's text is bounded, and it is a window failure, not any error.
      ...[
        { _tag: 'WindowFailure', text: 'x'.repeat(ipcLimits.errorMessageLength + 1) },
        { _tag: 'WorkspaceStoreError', failure: 'publication' },
        { _tag: 'WindowFailure', text: 'bad', private: true },
      ].map((cleanupError) => ['answerQuit', { id: 'quit', consent: true, cleanupError }] as const),
    ] as const)
      assert.equal((await f.call(tag, payload)).error?._tag, 'Die', tag);
    const raw = (await f.connectRaw())!;
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
  const chat: Partial<ChatServiceShape> = { getChat: () => workspace.held };
  const f = await makeIpcFixture({
    editor: { workspace: workspace.workspace },
    chat: {
      backends: {
        ...fakeChatTargets({ local: { chat, context }, remote: { chat, context } }),
        chooseFolder: Effect.succeed(null),
      },
    },
  });
  try {
    f.approvals.adoptCheckout(target);
    const raw = (await f.connectRaw())!;
    let id = 0;
    const send = (tag: string, payload: unknown) =>
      raw.send({ _tag: 'Request', id: String(id++), tag, payload, headers: [] });
    for (let index = 0; index < ipcLimits.editorRequests; index++) send('readFile', read);
    for (let index = 0; index < ipcLimits.editorRequests; index++)
      send('watchWorkspace', { checkout: target, paths: [] });
    const chatRead = { target: { ...context, conversationId: 'chat' } };
    for (let index = 0; index < ipcLimits.chatRequests; index++)
      send('getChat', { backendId: 'remote', input: chatRead });
    await waitFor(
      () => workspace.state.reads === ipcLimits.editorRequests + ipcLimits.chatRequests,
    );
    const busy = { ok: false, error: { _tag: 'IpcBusyError', limit: 'requests' } };
    assert.deepEqual(await f.call('getChat', { backendId: 'remote', input: chatRead }), busy);
    // Remote chat's full pool leaves local chat's folder picker and the target list alone.
    assert.deepEqual(await f.call('chooseChatFolder', null), { ok: true, value: null });
    assert.equal((await f.call('getChatTargets', null)).ok, true);
    for (let index = 0; index < ipcLimits.chatRequests; index++)
      send('getChat', { backendId: 'local', input: chatRead });
    await waitFor(
      () =>
        workspace.state.reads === ipcLimits.editorRequests + 2 * ipcLimits.chatRequests &&
        workspace.state.watches === ipcLimits.editorRequests,
    );
    // The next of each kind is refused, not queued.
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
  const chat: Partial<ChatServiceShape> = {
    sendChat: (input) =>
      Effect.andThen(
        Effect.sync(() => void sent.push(input)),
        Effect.fail(new UncertainError({ operation: 'sendChat' })),
      ),
  };
  const f = await makeIpcFixture({
    chat: { backends: fakeChatTargets({ local: { chat, context } }) },
  });
  try {
    const { chat } = await f.ports('local');
    const target = { ...context, conversationId: 'chat' };
    const input = {
      target,
      requestId: 'escaped',
      text: 'x' + '\u0001'.repeat(maximumChatInputBytes - 1),
    };
    await assert.rejects(Effect.runPromise(chat.sendChat(input)), { _tag: 'UncertainError' });
    assert.deepEqual(sent, [input]);
    assert.equal(sent.length, 1);
  } finally {
    await f.dispose();
  }
});

test('a handler’s defect reaches the renderer without its diagnostics, and its error as itself', async () => {
  const secret = '/Users/someone/private';
  let failure: Effect.Effect<never, WorkspaceStoreError> = Effect.die(Error(secret));
  const f = await makeIpcFixture({
    editor: { workspace: { readFile: () => failure } },
  });
  try {
    f.approvals.adoptCheckout(target);
    assert.deepEqual(await f.call('readFile', read), {
      ok: false,
      error: { _tag: 'IpcFailedError' },
    });
    const declared = new WorkspaceStoreError({ failure: 'publication' });
    failure = Effect.fail(declared);
    await assert.rejects(
      f.workspace((w) => w.readFile(read)),
      declared,
    );
  } finally {
    await f.dispose();
  }
});

test('releasing a document interrupts its requests, closes its watches and connections, and refuses none after', async () => {
  const workspace = heldWorkspace();
  const f = await makeIpcFixture({ editor: { workspace: workspace.workspace } });
  try {
    f.approvals.adoptCheckout(target);
    const raw = (await f.connectRaw())!;
    const reading = f.workspace((w) => w.readFile(read));
    void reading.catch(() => {});
    f.forkWorkspace((w) => Stream.runDrain(w.watch({ checkout: target, paths: [] })));
    await waitFor(() => workspace.state.reads === 1 && workspace.state.watches === 1);
    await f.releaseDocument();
    assert.equal(workspace.state.cancelled, 1);
    assert.equal(workspace.state.closed, 1);
    await raw.closed;
    await assert.rejects(reading);
    // The next document is served as usual.
    const next = f.workspace((w) => w.readFile(read));
    void next.catch(() => {});
    await waitFor(() => workspace.state.reads === 2);
    await f.close();
    assert.equal(workspace.state.cancelled, 2);
    assert.equal(await f.connectRaw(), undefined);
  } finally {
    await f.dispose();
  }
});
