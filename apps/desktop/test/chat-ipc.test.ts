import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Fiber, Stream } from 'effect';
import { UncertainError } from '@moonbase/contracts/errors';
import type { ChatListUpdate } from '@moonbase/contracts/chat';
import type { ProviderState } from '@moonbase/contracts/providers';
import type {
  ChatServiceShape,
  ConnectionServiceShape,
  ProviderSetupHandlers,
  ProviderSetupService,
} from '@moonbase/contracts/services';
import {
  fakeChatTargets,
  fakeService,
  makeIpcFixture,
  waitFor,
  watched,
} from './fixtures/ipc-fixture.ts';

const context = { host: { hostId: 'host', storeId: 'store' }, actorId: 'actor' };
const target = { ...context, conversationId: 'chat' };
/** A local target and a remote one, whose chat, provider and connection calls are recorded. */
async function chatFixture(
  options: { providers?: Partial<ProviderSetupService['Service']>; quitting?: () => boolean } = {},
) {
  const calls: { operation: string; input: unknown }[] = [];
  const watched_: Record<string, (value: unknown) => void> = {};
  let closes = 0;
  const record = (operation: string, input: unknown) =>
    Effect.sync(() => void calls.push({ operation, input }));
  /** A watch whose receiver is kept under `name`, counting its close. */
  const watch = (name: string) => () =>
    watched<never>((receive) => {
      watched_[name] = receive as never;
      return () => void closes++;
    });
  const chat: Partial<ChatServiceShape> = {
    sendChat: (input) =>
      Effect.andThen(
        record('sendChat', input),
        Effect.fail(new UncertainError({ operation: 'sendChat' })),
      ),
    getChatHistory: (input) => Effect.andThen(record('getChatHistory', input), Effect.never),
    watch: watch('chat'),
    watchChatList: watch('chatList'),
  };
  const connection: Partial<ConnectionServiceShape> = { watch: watch('connection') };
  const f = await makeIpcFixture({
    chat: {
      backends: {
        ...fakeChatTargets({
          local: { chat, context, ...(options.providers ? { providers: options.providers } : {}) },
          remote: { chat, context, connection },
        }),
        chooseFolder: Effect.succeed('/chosen'),
      },
    },
    lifecycle: { isQuitting: Effect.sync(options.quitting ?? (() => false)) },
  });
  return {
    f,
    calls,
    watched: watched_,
    get closes() {
      return closes;
    },
  };
}

test('a chat request reaches its target only for the configured host and actor, in a shape main reads', async () => {
  const { f, calls } = await chatFixture();
  try {
    const other = { ...target, actorId: 'other' };
    const otherStore = { ...target, host: { ...context.host, storeId: 'other' } };
    for (const [tag, payload, refusal] of [
      ['getChat', { backendId: 'local', input: { target: other } }, 'actor'],
      ['getChat', { backendId: 'local', input: { target: otherStore } }, 'host'],
      [
        'getChatTranscriptContent',
        { backendId: 'local', input: { source: { kind: 'entry', target: other, entryId: 'e' } } },
        'actor',
      ],
      [
        'getChatHistoryAround',
        { backendId: 'remote', input: { target: other, entryId: 'e' } },
        'actor',
      ],
      ['watchChat', { backendId: 'local', target: otherStore }, 'host'],
    ] as const)
      assert.deepEqual(await f.call(tag, payload), {
        ok: false,
        error: { _tag: 'IpcAuthorityError', refusal },
      });
    for (const [tag, payload] of [
      ['getChat', { backendId: 'elsewhere', input: { target } }],
      ['findChatTranscript', { backendId: 'local', input: { target, query: 'x'.repeat(1025) } }],
      ['connect', { input: { profileId: 7 } }],
    ] as const)
      assert.equal((await f.call(tag, payload)).error?._tag, 'Die', tag);
    assert.deepEqual(calls, []);
  } finally {
    await f.dispose();
  }
});

test('a Send keeps its exact payload and uncertain outcome; provider replies keep only their schema', async () => {
  let state: unknown = { providers: [], flow: null, privateToken: 'private' };
  const providers: Partial<ProviderSetupService['Service']> = {
    forOwner: () =>
      fakeService<ProviderSetupHandlers>('Provider setup', {
        getProviders: () => Effect.sync(() => state as ProviderState),
      }),
  };
  const { f, calls } = await chatFixture({ providers });
  try {
    const { chat, providers: setup } = await f.ports('local');
    const input = { target, requestId: 'original', text: 'captured' };
    await assert.rejects(Effect.runPromise(chat.sendChat(input)), { _tag: 'UncertainError' });
    assert.deepEqual(calls, [{ operation: 'sendChat', input }]);
    assert.deepEqual(await Effect.runPromise(setup.getProviders({})), {
      providers: [],
      flow: null,
    });
    state = { providers: [], flow: { id: 'incomplete' } };
    await assert.rejects(Effect.runPromise(setup.getProviders({})), { _tag: 'IpcReplyError' });
  } finally {
    await f.dispose();
  }
});

test('chat, chat list and connection watches reach the renderer through main and close with it', async () => {
  const fixture = await chatFixture();
  const { f, watched } = fixture;
  try {
    const received: unknown[] = [];
    const remote = await f.ports('remote');
    const fibers = [
      remote.chat.watch({ target }),
      remote.chat.watchChatList({ session: context }),
      remote.connection.watch(),
    ].map((stream: Stream.Stream<unknown, unknown>) =>
      Effect.runFork(Stream.runForEach(stream, (value) => Effect.sync(() => received.push(value)))),
    );
    await waitFor(() => watched.chat && watched.chatList && watched.connection);
    const list: ChatListUpdate = {
      list: { conversations: [], nextCursor: null },
      changed: [],
      dropped: 0,
      reset: false,
    };
    const disconnected = {
      profile: {
        id: 'host',
        label: 'Host',
        destination: 'host',
        remotePort: 8787,
        expected: context.host,
      },
      state: 'disconnected' as const,
      connectionId: null,
    };
    watched.chatList!(list);
    watched.connection!(disconnected);
    await waitFor(() => received.length === 2);
    assert.deepEqual(received, [list, disconnected]);
    await Effect.runPromise(Fiber.interruptAll(fibers));
    await waitFor(() => fixture.closes === 3);
  } finally {
    await f.dispose();
  }
});

test('a replaced document ends its chat waits and watches, but never stops a chat or disconnects', async () => {
  const fixture = await chatFixture();
  const { f, calls, watched } = fixture;
  try {
    const remote = await f.ports('remote');
    const waiting = Effect.runPromise(remote.chat.getChatHistory({ target, cursor: 'page' }));
    void waiting.catch(() => {});
    Effect.runFork(Effect.ignore(Stream.runDrain(remote.connection.watch())));
    await waitFor(() => calls.length === 1 && watched.connection);
    // Its waits and watches end with it.
    await f.releaseDocument();
    await assert.rejects(waiting);
    assert.equal(fixture.closes, 1);
    assert.deepEqual(
      calls.map((call) => call.operation),
      ['getChatHistory'],
    );
  } finally {
    await f.dispose();
  }
});

test('local chat’s native actions are refused while Moonbase quits', async () => {
  let quitting = false;
  const { f } = await chatFixture({ quitting: () => quitting });
  try {
    assert.equal(await f.shell.chooseChatFolder(), '/chosen');
    quitting = true;
    for (const [tag, payload, feature] of [
      ['chooseChatFolder', null, 'folder-picker'],
      [
        'createChatWorktree',
        { root: '/r', branch: 'chat/b', requestId: 'request' },
        'new-worktree',
      ],
      ['turnChatIntoProject', { conversationId: 'chat' }, 'turn-into-project'],
    ] as const)
      assert.deepEqual(await f.call(tag, payload), {
        ok: false,
        error: { _tag: 'IpcUnavailableError', feature },
      });
  } finally {
    await f.dispose();
  }
});
