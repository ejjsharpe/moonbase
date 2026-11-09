import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApplicationError } from '@moonbase/contracts/workspace';
import { Effect } from 'effect';
import type {
  ChatClient,
  ChatSnapshot,
  ChatSummary,
  ChatTarget,
  ChatCommands,
} from '@moonbase/contracts/chat';
import type { ConnectionClient, ConnectionSnapshot } from '@moonbase/contracts/connection';
import { type DraftStorage } from '@moonbase/application/chat';
import { modelRoot } from './chat-model-fixture.ts';
const context = { host: { hostId: 'host', storeId: 'store' }, actorId: 'owner' },
  target = { ...context, conversationId: 'chat' };
const summary = {
  target,
  title: 'Saved',
  cwd: '/remote/folder',
  model: 'configured-model',
  createdAt: '2026-01-01T00:00:00Z',
};
const snapshot: ChatSnapshot = {
  conversation: summary,
  state: 'idle',
  run: null,
  entries: [],
  olderCursor: null,
};
const profile = {
  id: 'configured',
  label: 'Configured',
  destination: 'example',
  remotePort: 9876,
  expected: context.host,
};
const failure = () =>
  new ApplicationError({ code: 'Uncertain', message: 'Controlled response loss' });
class Storage implements DraftStorage {
  value: string | null = null;
  fail = false;
  writes = 0;
  read() {
    return this.value;
  }
  write(value: string) {
    this.writes++;
    if (this.fail) throw Error('Controlled full storage');
    this.value = value;
  }
}
async function fixture(
  t: { after: (close: () => Promise<void>) => void },
  storage = new Storage(),
) {
  const root = modelRoot();
  t.after(() => root.close());
  let connectionState: ConnectionSnapshot = { state: 'disconnected', connectionId: null, profile },
    receiveConnection: (v: ConnectionSnapshot) => void = () => {},
    receiveChat: (v: ChatSnapshot) => void = () => {};
  let subscriptions = 0,
    id = 0;
  const calls: { operation: string; input: unknown }[] = [];
  const answers = new Map<string, (v: never) => Promise<unknown>>();
  const signals = new Map<string, AbortSignal[]>();
  // Trusted ChatClient: it stands in for a boundary that already decoded and bounded replies.
  const chat: ChatClient = {
    command: async (op, input, options) => {
      if (options?.signal) signals.set(op, [...(signals.get(op) ?? []), options.signal]);
      calls.push({ operation: op, input: structuredClone(input) });
      const handler = answers.get(op);
      if (handler) return (await handler(input as never)) as never;
      switch (op) {
        case 'getChatHost':
          return { ...context, cwd: summary.cwd, model: summary.model } as never;
        case 'listChats':
          return { conversations: [summary], nextCursor: null } as never;
        case 'createChat':
          return {
            requestId: (input as ChatCommands['createChat']['input']).requestId,
            conversation: summary,
          } as never;
        case 'getChat':
          return structuredClone(snapshot) as never;
        case 'sendChat':
          return {
            target,
            requestId: (input as ChatCommands['sendChat']['input']).requestId,
            admission: 'admitted',
            submissionId: 'submission',
          } as never;
        case 'getChatSend':
          return null as never;
        case 'stopChat':
          return { ...input, outcome: 'terminal' } as never;
        default:
          throw Error(op);
      }
    },
    watch: (_i, receive) => {
      receiveChat = receive;
      subscriptions++;
      return async () => {
        subscriptions--;
      };
    },
  };
  const connection: ConnectionClient = {
    command: async (op) => {
      calls.push({ operation: op, input: {} });
      if (op === 'connect') {
        connectionState = {
          state: 'connected',
          connectionId: 'generation-' + ++id,
          profile,
          health: { ...context.host, protocol: 1, version: '0.1.0', capabilities: ['chat-v0'] },
        };
        receiveConnection(connectionState);
      }
      if (op === 'disconnect') {
        connectionState = { state: 'disconnected', connectionId: null, profile };
        receiveConnection(connectionState);
      }
      return connectionState as never;
    },
    watch: (receive) => {
      receiveConnection = receive;
      return async () => {};
    },
  };
  const controller = await root.make({
    chat,
    connection,
    context,
    storage,
    newId: () => `request-${++id}`,
  });
  return {
    controller,
    root,
    chat,
    connection,
    calls,
    answers,
    signals,
    storage,
    publish: (v: ChatSnapshot) => receiveChat(v),
    publishConnection: (v: ConnectionSnapshot) => {
      connectionState = v;
      receiveConnection(v);
    },
    get subscriptions() {
      return subscriptions;
    },
  };
}
const turn = () => new Promise((r) => setTimeout(r, 0));
async function ready(f: Awaited<ReturnType<typeof fixture>>) {
  await f.controller.start();
  await f.controller.connect();
  await turn();
  await f.controller.select(target);
}

test('new-conversation drafts preserve before a chat exists and reopen without mutations', async (t) => {
  const f = await fixture(t);
  f.controller.setDraft('A draft before opening a project or chat');
  assert.equal(f.controller.getSnapshot().selected, null);
  assert.equal(f.controller.preserve(), true);
  await f.controller.dispose();
  const second = await f.root.make({
    chat: f.chat,
    connection: f.connection,
    context,
    storage: f.storage,
  });
  assert.equal(second.getSnapshot().draft, 'A draft before opening a project or chat');
  assert.deepEqual(f.calls, []);
});

test('explicit model and effort preferences survive chat selection, new chats and controller restart', async (t) => {
  const f = await fixture(t);
  assert.equal(f.controller.getSnapshot().modelPreference, null);
  const preference = {
    model: { provider: 'openai', modelId: 'gpt-6.1-sol' },
    reasoningEffort: 'xhigh' as const,
  };
  f.controller.setModelPreference(preference);
  preference.model.modelId = 'changed by caller';
  const expected = {
    model: { provider: 'openai', modelId: 'gpt-6.1-sol' },
    reasoningEffort: 'xhigh',
  };
  assert.deepEqual(f.controller.getSnapshot().modelPreference, expected);
  await ready(f);
  assert.deepEqual(f.controller.getSnapshot().modelPreference, expected);
  await f.controller.closeView();
  f.controller.setDraft('First new chat');
  await f.controller.send();
  await f.controller.closeView();
  assert.deepEqual(f.controller.getSnapshot().modelPreference, expected);
  assert.equal(f.controller.preserve(), true);
  await f.controller.dispose();
  const second = await f.root.make({
    chat: f.chat,
    connection: f.connection,
    context,
    storage: f.storage,
  });
  assert.deepEqual(second.getSnapshot().modelPreference, expected);
  await second.start();
  assert.deepEqual(second.getSnapshot().modelPreference, expected);
  assert.equal(f.calls.filter((call) => call.operation === 'createChat').length, 1);
});

test('invalid or fenced model preferences cannot replace preserved settings', async (t) => {
  const f = await fixture(t);
  const preference = {
    model: { provider: 'openai', modelId: 'gpt-6.1-sol' },
    reasoningEffort: 'high' as const,
  };
  f.controller.setModelPreference(preference);
  const raw = f.storage.value;
  f.controller.setModelPreference({ ...preference, reasoningEffort: 'invented' as 'high' });
  assert.equal(f.storage.value, raw);
  assert.deepEqual(f.controller.getSnapshot().modelPreference, preference);
  await f.controller.dispose();
  f.controller.setModelPreference({ ...preference, reasoningEffort: 'medium' });
  assert.equal(f.storage.value, raw);
});

test('first Send creates once and sends the captured message to its exact conversation', async (t) => {
  const f = await fixture(t);
  await ready(f);
  await f.controller.closeView();
  f.controller.setDraft('Explain the editor');
  assert(!f.calls.some((call) => call.operation === 'createChat'));
  await Promise.all([f.controller.send(), f.controller.send()]);
  const creates = f.calls.filter((call) => call.operation === 'createChat');
  const sends = f.calls.filter((call) => call.operation === 'sendChat');
  assert.equal(creates.length, 1);
  assert.equal((creates[0]!.input as { title: string }).title, 'Explain the editor');
  assert.equal(sends.length, 1);
  assert.deepEqual((sends[0]!.input as { target: ChatTarget }).target, target);
  assert.equal((sends[0]!.input as { text: string }).text, 'Explain the editor');
  assert.equal(f.controller.getSnapshot().draft, '');
  assert.equal(f.controller.getSnapshot().pending.length, 0);
});

test('first Send checks draft capacity before creating and succeeds after an existing draft is cleared', async (t) => {
  const f = await fixture(t);
  await ready(f);
  for (let i = 0; i < 32; i++) {
    await f.controller.select({ ...target, conversationId: 'draft-' + i });
    f.controller.setDraft('retained-' + i);
  }
  await f.controller.closeView();
  f.controller.setDraft('Keep my first message');
  await f.controller.send();
  assert(!f.calls.some((call) => ['createChat', 'sendChat'].includes(call.operation)));
  assert.match(f.controller.getSnapshot().error!, /32 conversation drafts/);
  assert.equal(f.controller.getSnapshot().draft, 'Keep my first message');
  assert.equal(f.controller.preserve(), true);
  await f.controller.select({ ...target, conversationId: 'draft-0' });
  f.controller.setDraft('');
  await f.controller.closeView();
  await f.controller.send();
  assert.equal(f.calls.filter((call) => call.operation === 'createChat').length, 1);
  assert.equal(f.calls.filter((call) => call.operation === 'sendChat').length, 1);
  assert.equal(f.controller.getSnapshot().draft, '');
});

test('typing during first-chat creation survives the captured first Send', async (t) => {
  const f = await fixture(t);
  await ready(f);
  await f.controller.closeView();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.answers.set('createChat', async (input: ChatCommands['createChat']['input']) => {
    await gate;
    return { requestId: input.requestId, conversation: summary };
  });
  f.controller.setDraft('Captured first message');
  const sending = f.controller.send();
  await turn();
  f.controller.setDraft('Newer unsent edit');
  release();
  await sending;
  assert.equal(f.controller.getSnapshot().draft, 'Newer unsent edit');
  assert.equal(
    (f.calls.find((call) => call.operation === 'sendChat')!.input as { text: string }).text,
    'Captured first message',
  );
});

for (const firstReply of [0, 1] as const)
  for (const sendSettled of [false, true])
    test(`late duplicate Create receipt preserves a newer new-chat draft (${firstReply ? 'retry' : 'initial'} first, Send ${sendSettled ? 'settled' : 'pending'})`, async (t) => {
      const f = await fixture(t);
      await ready(f);
      await f.controller.closeView();
      const replies = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
      const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
      const sendStarted = Promise.withResolvers<void>();
      const sendReply = Promise.withResolvers<void>();
      let creations = 0;
      f.answers.set('createChat', async (input: ChatCommands['createChat']['input']) => {
        const index = creations++;
        started[index]!.resolve();
        await replies[index]!.promise;
        return { requestId: input.requestId, conversation: summary };
      });
      f.answers.set('sendChat', async (input: ChatCommands['sendChat']['input']) => {
        sendStarted.resolve();
        await sendReply.promise;
        return {
          target,
          requestId: input.requestId,
          admission: 'admitted',
          submissionId: 'submission',
        };
      });
      f.controller.setDraft('Captured first message');
      const initial = f.controller.send();
      await started[0]!.promise;
      const pending = f.controller.getSnapshot().pending[0]!;
      assert(pending.operation === 'createChat' && pending.firstMessage);
      const retry = f.controller.retry(pending.input.requestId);
      const workflows = [initial, retry];
      try {
        await started[1]!.promise;
        replies[firstReply]!.resolve();
        await sendStarted.promise;
        if (sendSettled) {
          sendReply.resolve();
          await workflows[firstReply];
        }
        await f.controller.closeView();
        f.controller.setDraft('A different new conversation');
        replies[1 - firstReply]!.resolve();
        await workflows[1 - firstReply];
        const state = f.controller.getSnapshot();
        assert.equal(state.selected, null);
        assert.equal(state.draft, 'A different new conversation');
        assert.equal(state.error, null);
        assert.equal(state.storageError, null);
        assert.equal(JSON.parse(f.storage.value!).newDraft, 'A different new conversation');
        assert.equal(f.calls.filter((call) => call.operation === 'sendChat').length, 1);
        assert.equal(state.pending.length, sendSettled ? 0 : 1);
        sendReply.resolve();
        await workflows[firstReply];
        assert.equal(f.controller.getSnapshot().pending.length, 0);
        assert.equal(f.controller.getSnapshot().draft, 'A different new conversation');
        assert.equal(f.controller.preserve(), true);
      } finally {
        for (const reply of replies) reply.resolve();
        sendReply.resolve();
        await Promise.all(workflows);
      }
    });

test('draft capacity reached during Create retains exact recovery and resumes after capacity is freed', async (t) => {
  const f = await fixture(t);
  await ready(f);
  for (let i = 0; i < 31; i++) {
    await f.controller.select({ ...target, conversationId: 'draft-' + i });
    f.controller.setDraft('retained-' + i);
  }
  await f.controller.closeView();
  f.controller.setDraft('Captured first message');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.answers.set('createChat', async (input: ChatCommands['createChat']['input']) => {
    await gate;
    return { requestId: input.requestId, conversation: summary };
  });
  const sending = f.controller.send();
  await turn();
  await f.controller.select({ ...target, conversationId: 'last-slot' });
  f.controller.setDraft('Another conversation draft');
  release();
  await sending;
  assert.match(f.controller.getSnapshot().error!, /conversation was created, but the draft limit/);
  const retained = f.controller.getSnapshot().pending[0]!;
  assert(retained.operation === 'createChat' && retained.firstMessage);
  assert.equal(retained.firstMessage.text, 'Captured first message');
  assert(!f.calls.some((call) => call.operation === 'sendChat'));
  assert.equal(f.controller.preserve(), true);
  f.controller.setDraft('');
  await f.controller.retry(retained.input.requestId);
  assert.equal(f.calls.filter((call) => call.operation === 'sendChat').length, 1);
  assert.deepEqual(
    f.calls.filter((call) => call.operation === 'createChat').map((call) => call.input),
    [retained.input, retained.input],
  );
});

test('lost first-chat Create retains both identities across reload and sends only on original retry', async (t) => {
  const f = await fixture(t);
  await ready(f);
  await f.controller.closeView();
  f.answers.set('createChat', async () => {
    throw failure();
  });
  f.controller.setDraft('Original first message');
  await f.controller.send();
  const pending = f.controller.getSnapshot().pending[0]!;
  assert(pending.operation === 'createChat' && pending.firstMessage);
  f.controller.setDraft('Newer edit');
  await f.controller.dispose();
  const second = await f.root.make({
    chat: f.chat,
    connection: f.connection,
    context,
    storage: f.storage,
    newId: () => {
      throw Error('Must retain original IDs');
    },
  });
  await second.start();
  await turn();
  assert(!f.calls.some((call) => call.operation === 'sendChat'));
  f.answers.delete('createChat');
  await second.retry(pending.input.requestId);
  const creates = f.calls.filter((call) => call.operation === 'createChat');
  assert.deepEqual(creates[0]!.input, creates[1]!.input);
  const send = f.calls.find((call) => call.operation === 'sendChat')!.input;
  assert.deepEqual(send, { ...pending.firstMessage, target });
  assert.equal(second.getSnapshot().draft, 'Newer edit');
});

test('uncertain first Send retains the Send without creating another conversation', async (t) => {
  const f = await fixture(t);
  await ready(f);
  await f.controller.closeView();
  f.answers.set('sendChat', async () => {
    throw failure();
  });
  f.controller.setDraft('First message');
  await f.controller.send();
  const pending = f.controller.getSnapshot().pending[0]!;
  assert.equal(pending.operation, 'sendChat');
  const original = structuredClone(pending.input);
  await f.controller.dispose();
  const second = await f.root.make({
    chat: f.chat,
    connection: f.connection,
    context,
    storage: f.storage,
  });
  await second.start();
  await turn();
  assert.equal(f.calls.filter((call) => call.operation === 'sendChat').length, 1);
  f.answers.delete('sendChat');
  await second.retry(pending.input.requestId);
  assert.equal(f.calls.filter((call) => call.operation === 'createChat').length, 1);
  assert.deepEqual(f.calls.filter((call) => call.operation === 'sendChat')[1]!.input, original);
});

test('failed first-message publication prevents Send after a successful Create', async (t) => {
  const f = await fixture(t);
  await ready(f);
  await f.controller.closeView();
  f.controller.setDraft('Keep this message');
  f.answers.set('createChat', async (input: ChatCommands['createChat']['input']) => {
    f.storage.fail = true;
    return { requestId: input.requestId, conversation: summary };
  });
  await f.controller.send();
  assert(!f.calls.some((call) => call.operation === 'sendChat'));
  assert.equal(f.controller.getSnapshot().draft, 'Keep this message');
  assert.equal(f.controller.preserve(), false);
});

test('automatic conversation titles bound Unicode by UTF-8 bytes', async (t) => {
  const f = await fixture(t);
  await ready(f);
  await f.controller.closeView();
  f.controller.setDraft('🌙'.repeat(100));
  await f.controller.send();
  const title = (
    f.calls.find((call) => call.operation === 'createChat')!.input as { title: string }
  ).title;
  assert.equal(new TextEncoder().encode(title).length, 80);
  assert.equal(title.isWellFormed(), true);
});

test('first-message Create retry preserves a discovered conversation draft and a newer new-chat draft', async (t) => {
  const f = await fixture(t);
  await ready(f);
  await f.controller.closeView();
  f.answers.set('createChat', async () => {
    throw failure();
  });
  f.controller.setDraft('Captured first message');
  await f.controller.send();
  const pending = f.controller.getSnapshot().pending[0]!;
  f.controller.setDraft('New unsent conversation');
  await f.controller.select(target);
  f.controller.setDraft('Edited discovered conversation');
  f.answers.delete('createChat');
  await f.controller.retry(pending.input.requestId);
  assert.equal(f.controller.getSnapshot().draft, 'Edited discovered conversation');
  assert.equal(f.controller.getSnapshot().storageError, null);
  await f.controller.closeView();
  assert.equal(f.controller.getSnapshot().draft, 'New unsent conversation');
});

test('local first Send requires folder/model settings and retains the exact approved settings', async (t) => {
  const f = await fixture(t);
  const controller = await f.root.make({
    chat: {
      ...f.chat,
      command: (operation, input, options) =>
        operation === 'getChatHost'
          ? Promise.resolve({ ...context, mode: 'local' } as never)
          : f.chat.command(operation, input, options),
    },
    mode: 'local',
    context,
    storage: new Storage(),
  });
  await controller.start();
  controller.setDraft('Local first message');
  await controller.send();
  assert(!f.calls.some((call) => call.operation === 'createChat'));
  assert.equal(controller.getSnapshot().draft, 'Local first message');
  const settings = {
    cwd: '/approved/project',
    model: { provider: 'configured', modelId: 'model' },
    reasoningEffort: 'xhigh' as const,
  };
  await controller.send(settings);
  assert.deepEqual(
    (f.calls.find((call) => call.operation === 'createChat')!.input as { settings: unknown })
      .settings,
    settings,
  );
  assert.equal(f.calls.filter((call) => call.operation === 'sendChat').length, 1);
});

test('throwing chat subscribers cannot poison saved drafts or block Send and preservation', async (t) => {
  const f = await fixture(t);
  await ready(f);
  let delivered = 0;
  f.controller.subscribe(() => {
    throw Error('Controlled view failure');
  });
  f.controller.subscribe(() => {
    delivered++;
  });
  assert.equal(f.controller.preserve(), true);
  assert.doesNotThrow(() => f.controller.setDraft('Preserved despite view failure'));
  assert.equal(f.controller.getSnapshot().storageError, null);
  assert.equal(JSON.parse(f.storage.value!).drafts[0].text, 'Preserved despite view failure');
  assert(delivered > 0);
  await f.controller.send();
  assert.equal(f.calls.filter((call) => call.operation === 'sendChat').length, 1);
  assert.equal(f.controller.getSnapshot().storageError, null);
  assert.equal(f.controller.preserve(), true);
});

test('existing version-1 drafts and pending identities reopen unchanged through the public entry', async (t) => {
  const storage = new Storage();
  const saved = {
    version: 1,
    session: context,
    selected: target,
    drafts: [{ target, text: 'Existing unsent draft' }],
    pending: [
      {
        operation: 'sendChat',
        input: { target, requestId: 'existing-request', text: 'Original uncertain Send' },
        message: 'Uncertain: response lost',
      },
    ],
  };
  storage.value = JSON.stringify(saved);
  const f = await fixture(t, storage);
  assert.equal(f.controller.getSnapshot().draft, saved.drafts[0].text);
  assert.deepEqual(f.controller.getSnapshot().pending, saved.pending);
  assert.equal(f.controller.preserve(), true);
  assert.equal(storage.value, JSON.stringify(saved));
  assert.deepEqual(f.calls, []);
  await f.controller.dispose();
});

test('startup only observes; every mutation is durably captured before disclosure', async (t) => {
  const f = await fixture(t);
  await f.controller.start();
  assert(
    !f.calls.some((c) => ['connect', 'createChat', 'sendChat', 'stopChat'].includes(c.operation)),
  );
  await ready(f);
  f.controller.setDraft('captured');
  f.answers.set('sendChat', async (input) => {
    const saved = JSON.parse(f.storage.value!);
    assert.deepEqual(saved.pending[0].input, input);
    return {
      target,
      requestId: saved.pending[0].input.requestId,
      admission: 'admitted',
      submissionId: 'one',
    };
  });
  await f.controller.send();
  assert.equal(f.controller.getSnapshot().draft, '');
  assert.equal(f.controller.getSnapshot().pending.length, 0);
  await f.controller.dispose();
});
test('lost reply, null query, reload and reconnect retain original input without auto Send', async (t) => {
  const f = await fixture(t);
  await ready(f);
  f.controller.setDraft('original');
  f.answers.set('sendChat', async () => {
    throw failure();
  });
  await f.controller.send();
  const p = f.controller.getSnapshot().pending[0];
  assert(p.operation === 'sendChat');
  assert.equal(p.input.text, 'original');
  await f.controller.query(p.input.requestId);
  assert.deepEqual(f.controller.getSnapshot().pending[0].input, p.input);
  await f.controller.dispose();
  const second = await f.root.make({
    chat: f.chat,
    connection: f.connection,
    context,
    storage: f.storage,
  });
  await second.start();
  await turn();
  assert.deepEqual(second.getSnapshot().pending[0].input, p.input);
  assert.equal(f.calls.filter((c) => c.operation === 'sendChat').length, 1);
  await second.disconnect();
  await second.connect();
  await turn();
  assert.equal(f.calls.filter((c) => c.operation === 'sendChat').length, 1);
  await second.dispose();
});
test('matching Send recovery clears only captured draft text and preserves newer edits', async (t) => {
  const f = await fixture(t);
  await ready(f);
  f.controller.setDraft('captured');
  let release!: (v: unknown) => void;
  f.answers.set('sendChat', () => new Promise((r) => (release = r)));
  const sending = f.controller.send();
  await turn();
  f.controller.setDraft('newer edit');
  release({
    target,
    requestId: f.controller.getSnapshot().pending[0].input.requestId,
    admission: 'admitted',
    submissionId: 'one',
  });
  await sending;
  assert.equal(f.controller.getSnapshot().draft, 'newer edit');
  assert.equal(f.controller.getSnapshot().pending.length, 0);
  await f.controller.dispose();
});
for (const operation of ['createChat', 'sendChat', 'stopChat'])
  test(`${operation} never discloses when pending metadata write fails`, async (t) => {
    const f = await fixture(t);
    await ready(f);
    f.controller.setDraft('retained');
    f.publish({
      ...snapshot,
      state: 'running',
      run: {
        state: 'running',
        stop: { target, submissionId: 'one', taskId: 'task' },
        text: '',
        truncated: false,
        tools: [],
      },
    });
    f.storage.fail = true;
    const before = f.calls.length;
    if (operation === 'createChat') await f.controller.create('Title');
    if (operation === 'sendChat') await f.controller.send();
    if (operation === 'stopChat') await f.controller.stop();
    assert(!f.calls.slice(before).some((c) => c.operation === operation));
    assert(f.controller.getSnapshot().storageError);
    assert.equal(f.controller.preserve(), false);
    assert.equal(f.controller.getSnapshot().draft, 'retained');
    await f.controller.dispose();
  });
for (const value of [
  '{broken',
  JSON.stringify({
    version: 1,
    session: { ...context, actorId: 'other' },
    selected: null,
    drafts: [],
    pending: [],
  }),
])
  test(
    'corruption/foreign context remains untouched and blocks admission on reload: ' +
      value.slice(0, 12),
    async (t) => {
      const storage = new Storage();
      storage.value = value;
      const f = await fixture(t, storage);
      await f.controller.start();
      await f.controller.connect();
      await f.controller.create('Do not send');
      assert(f.controller.getSnapshot().storageError);
      assert.equal(storage.value, value);
      assert(!f.calls.some((c) => c.operation === 'createChat'));
      await f.controller.dispose();
    },
  );
test('write failure preserves latest live edit and blocks Quit instead of claiming reload safety', async (t) => {
  const f = await fixture(t);
  await ready(f);
  f.controller.setDraft('saved');
  f.storage.fail = true;
  f.controller.setDraft('latest live text');
  assert.equal(f.controller.getSnapshot().draft, 'latest live text');
  assert.equal(f.controller.preserve(), false);
  assert(JSON.parse(f.storage.value!).drafts.some((d: { text: string }) => d.text === 'saved'));
  await f.controller.dispose();
});
test('same-input retry queries first, keeps original Create/Send/Stop identities, and never adopts successor', async (t) => {
  const f = await fixture(t);
  await ready(f);
  for (const op of ['createChat', 'sendChat', 'stopChat'])
    f.answers.set(op, async () => {
      throw failure();
    });
  await f.controller.create('Original title');
  f.controller.setDraft('Original message');
  await f.controller.send();
  const old = { target, submissionId: 'original-submission', taskId: 'original-task' };
  f.publish({
    ...snapshot,
    state: 'running',
    run: { state: 'running', stop: old, text: '', truncated: false, tools: [] },
  });
  await f.controller.stop();
  const pending = structuredClone(f.controller.getSnapshot().pending);
  f.publish({
    ...snapshot,
    state: 'running',
    run: {
      state: 'running',
      stop: { target, submissionId: 'later', taskId: 'successor' },
      text: '',
      truncated: false,
      tools: [],
    },
  });
  for (const p of pending) {
    const before = f.calls.length;
    await f.controller.retry(p.input.requestId);
    const c = f.calls.slice(before);
    assert(c[0].operation.startsWith('get') || c[0].operation === 'listChats');
    assert.deepEqual(c.at(-1), { operation: p.operation, input: p.input });
  }
  assert.deepEqual(
    f.controller.getSnapshot().pending.map((p) => p.input),
    pending.map((p) => p.input),
  );
  await f.controller.dispose();
});
test('pending Send does not block captured Stop or status and detach never stops work', async (t) => {
  const f = await fixture(t);
  await ready(f);
  f.controller.setDraft('wait');
  let release!: (v: unknown) => void;
  f.answers.set('sendChat', () => new Promise((r) => (release = r)));
  const sending = f.controller.send();
  await turn();
  f.publish({
    ...snapshot,
    state: 'running',
    run: {
      state: 'running',
      stop: { target, submissionId: 'one', taskId: 'task' },
      text: 'live',
      truncated: false,
      tools: [],
    },
  });
  await f.controller.stop();
  assert(f.calls.some((c) => c.operation === 'stopChat'));
  const count = f.calls.filter((c) => c.operation === 'stopChat').length;
  await f.controller.closeView();
  assert.equal(f.subscriptions, 0);
  await f.controller.dispose();
  assert.equal(f.calls.filter((c) => c.operation === 'stopChat').length, count);
  release({ target, requestId: 'request-2', admission: 'reserved', submissionId: null });
  await sending;
});
test('read-only admitted lookup resolves without Send; foreign storage writes are never overwritten', async (t) => {
  const f = await fixture(t);
  await ready(f);
  f.controller.setDraft('Original');
  f.answers.set('sendChat', async () => {
    throw failure();
  });
  await f.controller.send();
  const p = f.controller.getSnapshot().pending[0];
  f.answers.set('getChatSend', async () => ({
    target,
    requestId: p.input.requestId,
    admission: 'admitted',
    submissionId: 'one',
  }));
  f.controller.setDraft('newer');
  await f.controller.query(p.input.requestId);
  assert.equal(f.controller.getSnapshot().draft, 'newer');
  assert.equal(f.calls.filter((c) => c.operation === 'sendChat').length, 1);
  f.storage.value = 'external change';
  f.controller.setDraft('third');
  assert.equal(f.storage.value, 'external change');
  assert(f.controller.getSnapshot().storageError);
  await f.controller.dispose();
});
test('replacement watch snapshots and overlapping legacy history keep output bounded', async (t) => {
  const f = await fixture(t);
  await ready(f);
  for (let i = 0; i < 500; i++)
    f.publish({
      ...snapshot,
      entries: [{ id: 'entry', role: 'assistant', text: String(i), truncated: false }],
    });
  assert.equal(f.controller.getSnapshot().snapshot!.entries.length, 1);
  assert.equal(f.controller.getSnapshot().snapshot!.entries[0].text, '499');
  let pageNumber = 0;
  f.answers.set('getChatHistory', async () => ({
    entries: Array.from({ length: 32 }, (_, i) => ({
      id: 'older-' + i,
      role: 'user',
      text: 'bounded',
      truncated: false,
    })),
    olderCursor: 'next-' + ++pageNumber,
  }));
  f.publish({ ...snapshot, olderCursor: 'page' });
  for (let i = 0; i < 4; i++) await f.controller.showEarlier();
  assert.equal(f.controller.getSnapshot().transcript.entries.length, 32);
  await f.controller.dispose();
});
test('bounds reject oversized/invalid Unicode input without replacing retained draft or issuing Send', async (t) => {
  const f = await fixture(t);
  await ready(f);
  f.controller.setDraft('keep');
  f.controller.setDraft('a'.repeat(32769));
  assert.equal(f.controller.getSnapshot().draft, 'keep');
  f.controller.setDraft('\ud800');
  assert.equal(f.controller.getSnapshot().draft, 'keep');
  await f.controller.dispose();
});
test('Create and captured Stop are written before disclosure; lost replies recover exact inputs after reload', async (t) => {
  const f = await fixture(t);
  await ready(f);
  const stop = { target, submissionId: 'saved-submission', taskId: null };
  for (const op of ['createChat', 'stopChat'])
    f.answers.set(op, async (input) => {
      assert.deepEqual(JSON.parse(f.storage.value!).pending.at(-1).input, input);
      throw failure();
    });
  await f.controller.create('Preserved creation');
  f.publish({
    ...snapshot,
    state: 'running',
    run: { state: 'running', stop, text: '', truncated: false, tools: [] },
  });
  await f.controller.stop();
  const retained = structuredClone(f.controller.getSnapshot().pending);
  await f.controller.dispose();
  const next = await f.root.make({
    chat: f.chat,
    connection: f.connection,
    context,
    storage: f.storage,
  });
  assert.deepEqual(next.getSnapshot().pending, retained);
  await next.dispose();
});
test('start while attached keeps the open chat, its transcript and its watch', async (t) => {
  // The shell starts chat whenever a chat view shows, so a repeated start must not read it again.
  const f = await fixture(t);
  await ready(f);
  await turn();
  const before = f.controller.getSnapshot();
  const reads = f.calls.filter((c) => c.operation === 'getChat').length;
  assert(before.snapshot);
  await f.controller.start();
  await turn();
  const after = f.controller.getSnapshot();
  assert.equal(after.snapshot, before.snapshot);
  assert.equal(after.transcript, before.transcript);
  assert.equal(after.ready, true);
  assert.equal(f.subscriptions, 1);
  assert.equal(f.calls.filter((c) => c.operation === 'getChat').length, reads);
  f.publish({ ...snapshot, state: 'running' });
  assert.equal(f.controller.getSnapshot().snapshot?.state, 'running');
  await f.controller.dispose();
});
test('detach releases observations, resume is read-only, and draft capacity failure blocks Quit', async (t) => {
  const f = await fixture(t);
  await ready(f);
  await f.controller.detach();
  assert.equal(f.subscriptions, 0);
  await f.controller.start();
  assert.equal(f.subscriptions, 1);
  assert(!f.calls.some((c) => ['sendChat', 'stopChat'].includes(c.operation)));
  for (let i = 0; i < 32; i++) {
    await f.controller.select({ ...target, conversationId: 'draft-' + i });
    f.controller.setDraft('retained-' + i);
  }
  await f.controller.select({ ...target, conversationId: 'overflow' });
  f.controller.setDraft('latest live overflow');
  assert.equal(f.controller.getSnapshot().draft, 'latest live overflow');
  assert(f.controller.getSnapshot().storageError);
  assert.equal(f.controller.preserve(), false);
  assert.equal(JSON.parse(f.storage.value!).drafts.length, 32);
  await f.controller.dispose();
});
for (const operation of ['createChat', 'sendChat', 'stopChat'] as const)
  test(`${operation} retains the captured identity when Disconnect makes a dispatched reply Unavailable`, async (t) => {
    const f = await fixture(t);
    await ready(f);
    f.controller.setDraft('captured before disconnect');
    f.publish({
      ...snapshot,
      state: 'running',
      run: {
        state: 'running',
        stop: { target, submissionId: 'admitted', taskId: 'captured-task' },
        text: 'live',
        truncated: false,
        tools: [],
      },
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    f.answers.set(operation, async () => {
      await gate;
      throw new ApplicationError({
        code: 'Unavailable',
        message: 'Connection generation gone after dispatch',
      });
    });
    let call;
    if (operation === 'createChat') {
      call = f.controller.create('Captured create');
    } else {
      if (operation === 'sendChat') {
        call = f.controller.send();
      } else {
        call = f.controller.stop();
      }
    }
    await turn();
    const original = structuredClone(f.controller.getSnapshot().pending[0]);
    await f.controller.disconnect();
    release();
    await call;
    assert.deepEqual(f.controller.getSnapshot().pending[0].input, original.input);
    await f.controller.dispose();
    const next = await f.root.make({
      chat: f.chat,
      connection: f.connection,
      context,
      storage: f.storage,
    });
    await next.start();
    await next.connect();
    await turn();
    assert.deepEqual(next.getSnapshot().pending[0].input, original.input);
    assert.equal(f.calls.filter((c) => c.operation === operation).length, 1);
    await next.retry(original.input.requestId);
    assert.deepEqual(
      f.calls.filter((c) => c.operation === operation).at(-1)!.input,
      original.input,
    );
    await next.dispose();
  });

for (const operation of ['createChat', 'sendChat', 'stopChat'] as const)
  for (const duringQuery of [false, true])
    for (const failsWrite of [false, true])
      test(`${operation} retry vetoes ${failsWrite ? 'unwritable' : 'changed'} local storage ${duringQuery ? 'during query' : 'before retry'} before mutating redisclosure`, async (t) => {
        const f = await fixture(t);
        await ready(f);
        f.controller.setDraft('captured draft');
        f.answers.set(operation, async (input) => {
          if (operation === 'sendChat')
            return {
              target,
              requestId: (input as ChatCommands['sendChat']['input']).requestId,
              admission: 'reserved',
              submissionId: null,
            };
          throw failure();
        });
        if (operation === 'createChat') await f.controller.create('Captured title');
        else if (operation === 'sendChat') await f.controller.send();
        else {
          f.publish({
            ...snapshot,
            state: 'running',
            run: {
              state: 'running',
              stop: { target, submissionId: 'original-submission', taskId: 'original-task' },
              text: 'live',
              truncated: false,
              tools: [],
            },
          });
          await f.controller.stop();
        }
        f.controller.setDraft('newer live edit');
        const retained = structuredClone(f.controller.getSnapshot().pending[0]),
          original = JSON.parse(f.storage.value!);
        original.drafts[0].text = 'newer externally published edit';
        const replacement = failsWrite ? f.storage.value : JSON.stringify(original);
        const breakStorage = () => {
          if (failsWrite) f.storage.fail = true;
          else f.storage.value = replacement;
        };
        let query;
        if (operation === 'createChat') {
          query = 'listChats';
        } else {
          if (operation === 'sendChat') {
            query = 'getChatSend';
          } else {
            query = 'getChat';
          }
        }
        f.answers.set(query, async () => {
          if (duringQuery) breakStorage();
          if (operation === 'createChat') {
            return { conversations: [summary], nextCursor: null };
          } else {
            if (operation === 'sendChat') {
              return {
                target,
                requestId: retained.input.requestId,
                admission: 'reserved',
                submissionId: null,
              };
            } else {
              return snapshot;
            }
          }
        });
        f.answers.delete(operation);
        if (!duringQuery) breakStorage();
        const before = f.calls.filter((c) => c.operation === operation).length;
        await f.controller.retry(retained.input.requestId);
        assert.equal(
          f.calls.filter((c) => c.operation === operation).length,
          before,
          'metadata preservation must veto before the remote mutation',
        );
        assert.equal(f.storage.value, replacement);
        assert.deepEqual(f.controller.getSnapshot().pending[0].input, retained.input);
        assert.equal(f.controller.getSnapshot().draft, 'newer live edit');
        assert(f.controller.getSnapshot().storageError);
        const queries = f.calls.filter((c) => c.operation === query).length;
        await f.controller.query(retained.input.requestId);
        assert(
          f.calls.filter((c) => c.operation === query).length > queries,
          'safe read-only query remains available',
        );
        assert.equal(f.calls.filter((c) => c.operation === operation).length, before);
        await f.controller.dispose();
      });

for (const lifecycle of ['detach', 'dispose'] as const)
  test(`late Create reply reconciles its receipt without observing after ${lifecycle}`, async (t) => {
    const f = await fixture(t);
    await ready(f);
    let release!: (value: unknown) => void;
    f.answers.set('createChat', () => new Promise((resolve) => (release = resolve)));
    const creating = f.controller.create('Delayed creation');
    const pending = f.controller.getSnapshot().pending[0];
    await f.controller[lifecycle]();
    assert.equal(f.subscriptions, 0);
    const reads = f.calls.filter((c) => c.operation === 'getChat').length;
    release({ requestId: pending.input.requestId, conversation: summary });
    await creating;
    assert.equal(f.subscriptions, 0);
    assert.equal(f.calls.filter((c) => c.operation === 'getChat').length, reads);
    const saved = JSON.parse(f.storage.value!);
    assert.deepEqual(saved.pending, lifecycle === 'dispose' ? [pending] : []);
    assert.deepEqual(saved.selected, target);
    await f.controller.dispose();
  });

for (const extraField of ['selectedHost', 'createSession'] as const)
  test(`stored ${extraField} still requires an exact shape`, async (t) => {
    const storage = new Storage();
    const saved = {
      version: 1,
      session: context,
      selected: target,
      drafts: [],
      pending: [
        {
          operation: 'createChat',
          input: { session: context, requestId: 'retained', title: 'Saved' },
          message: 'Pending',
        },
      ],
    };
    if (extraField === 'selectedHost')
      saved.selected = { ...target, host: { ...context.host, extra: true } } as ChatTarget;
    else saved.pending[0].input.session = { ...context, extra: true } as typeof context;
    storage.value = JSON.stringify(saved);
    const original = storage.value;
    const f = await fixture(t, storage);
    await f.controller.start();
    await f.controller.connect();
    await f.controller.create('Blocked');
    assert(f.controller.getSnapshot().storageError);
    assert.equal(storage.value, original);
    assert(!f.calls.some((c) => c.operation === 'createChat'));
    await f.controller.dispose();
  });

for (const invalidate of ['resume', 'selection'] as const)
  test(`obsolete refresh cannot suppress current ${invalidate} reads`, async (t) => {
    const f = await fixture(t);
    await ready(f);
    await f.controller.detach();
    let release!: (value: unknown) => void;
    f.answers.set('listChats', () => new Promise((resolve) => (release = resolve)));
    const starting = f.controller.start();
    await turn();
    f.answers.delete('listChats');
    if (invalidate === 'resume') {
      await f.controller.detach();
      await f.controller.start();
    } else {
      await f.controller.select(target);
    }
    release({ conversations: [{ ...summary, title: 'Obsolete' }], nextCursor: null });
    await starting;
    await turn();
    assert(f.controller.getSnapshot().host, 'current generation restores host');
    assert.deepEqual(f.controller.getSnapshot().snapshot, snapshot);
    assert.equal(f.subscriptions, 1);
    assert.equal(f.controller.getSnapshot().chats[0].title, 'Saved');
    assert(!f.calls.some((c) => ['sendChat', 'stopChat'].includes(c.operation)));
    await f.controller.dispose();
  });

for (const lifecycle of ['detach', 'dispose'] as const)
  test(`pending refresh leaves Stop concurrent and cannot observe after ${lifecycle}`, async (t) => {
    const f = await fixture(t);
    await ready(f);
    let release!: (value: unknown) => void;
    f.answers.set('listChats', () => new Promise((resolve) => (release = resolve)));
    const refreshing = f.controller.refresh();
    await turn();
    f.publish({
      ...snapshot,
      state: 'running',
      run: {
        state: 'running',
        stop: { target, submissionId: 'one', taskId: 'task' },
        text: '',
        truncated: false,
        tools: [],
      },
    });
    await f.controller.stop();
    assert.equal(f.calls.filter((c) => c.operation === 'stopChat').length, 1);
    await f.controller[lifecycle]();
    const reads = f.calls.filter((c) => c.operation === 'listChats').length;
    release({ conversations: [], nextCursor: null });
    await refreshing;
    assert.equal(f.calls.filter((c) => c.operation === 'listChats').length, reads);
    assert.equal(f.controller.getSnapshot().host, null);
    assert.equal(f.controller.getSnapshot().snapshot, null);
    assert.equal(f.subscriptions, 0);
    await f.controller.dispose();
  });

function event<A = void>() {
  let resolve!: (value: A) => void, reject!: (error: unknown) => void;
  const promise = new Promise<A>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test('unfamiliar nested saved draft data stays byte-identical before any automatic write', async (t) => {
  const storage = new Storage();
  storage.value = JSON.stringify({
    version: 1,
    session: context,
    selected: target,
    drafts: [
      { target, text: 'Preserve prior producer text', futureField: { evidence: 'unknown' } },
    ],
    pending: [
      {
        operation: 'sendChat',
        input: { target, requestId: 'original-id', text: 'retained' },
        message: 'Uncertain',
      },
    ],
  });
  const original = storage.value,
    f = await fixture(t, storage);
  await f.controller.start();
  await f.controller.connect();
  await f.controller.create('Blocked');
  f.controller.setDraft('Cannot publish into incompatible namespace');
  assert.equal(f.controller.preserve(), false);
  assert(f.controller.getSnapshot().storageError);
  assert.equal(storage.value, original);
  assert.equal(storage.writes, 0);
  assert(!f.calls.some((call) => ['createChat', 'sendChat', 'stopChat'].includes(call.operation)));
});

for (const code of ['Persistence', 'Cancelled', null] as const)
  test(`two models share one runtime; pending ${code ?? 'unknown'} watch cleanup joins and fences all late writes`, async (t) => {
    const cleanup: (() => Promise<void>)[] = [];
    const f = await fixture({
      after: (close) => {
        cleanup.push(close);
      },
    });
    const held = event(),
      entered = event();
    const failure = code
      ? new ApplicationError({ code, message: 'Controlled watch release failed' })
      : new Error('SYNTHETIC_PRIVATE_CLEANUP_SENTINEL');
    t.after(async () => {
      held.reject(failure);
      for (const close of cleanup)
        await assert.rejects(
          close(),
          (error) =>
            ApplicationError.is(error) &&
            !error.message.includes('SYNTHETIC_PRIVATE_CLEANUP_SENTINEL'),
        );
    });
    await ready(f);
    await f.controller.closeView();
    const originalWatch = f.chat.watch;
    let closes = 0,
      late!: (snapshot: ChatSnapshot) => void;
    f.chat.watch = (_input, receive) => {
      late = receive;
      return () => {
        closes++;
        entered.resolve();
        return held.promise;
      };
    };
    await f.controller.select(target);
    f.chat.watch = originalWatch;
    const other = await f.root.make({
      chat: f.chat,
      connection: f.connection,
      context,
      storage: new Storage(),
    });
    await other.start();
    await other.select(target);
    const reply = event<unknown>();
    f.answers.set('sendChat', async (input) => {
      const captured = input as ChatCommands['sendChat']['input'];
      return captured.text === 'first retained'
        ? reply.promise
        : {
            target,
            requestId: captured.requestId,
            admission: 'admitted',
            submissionId: 'other-submission',
          };
    });
    f.controller.setDraft('first retained');
    const sending = f.controller.send();
    const pending = structuredClone(f.controller.getSnapshot().pending);
    const saved = f.storage.value,
      writes = f.storage.writes;
    const errors: ApplicationError[] = [];
    const closing = f.controller.dispose();
    assert.strictEqual(f.controller.dispose(), closing);
    let settled = false;
    const tracked = closing
      .catch((error) => {
        errors.push(error);
      })
      .finally(() => {
        settled = true;
      });
    await entered.promise;
    assert.equal(settled, false);
    assert.equal(f.signals.get('sendChat')!.at(-1)!.aborted, true);
    other.setDraft('other model remains usable');
    await other.send();
    assert.equal(other.getSnapshot().pending.length, 0);
    f.controller.setDraft('late edit');
    late({
      ...snapshot,
      entries: [{ id: 'late', role: 'assistant', text: 'late output', truncated: false }],
    });
    reply.resolve({
      target,
      requestId: pending[0].input.requestId,
      admission: 'admitted',
      submissionId: 'first',
    });
    await sending;
    assert.equal(f.storage.value, saved);
    assert.equal(f.storage.writes, writes);
    assert.deepEqual(JSON.parse(saved!).pending, pending);
    held.reject(failure);
    await tracked;
    assert.equal(closes, 1);
    assert.equal(errors.length, 1);
    assert(ApplicationError.is(errors[0]));
    assert(!errors[0].message.includes('SYNTHETIC_PRIVATE_CLEANUP_SENTINEL'));
    if (code) {
      assert.match(errors[0].message, /Controlled watch release failed/);
      assert.equal(errors[0].code, code);
    }
    await assert.rejects(f.controller.dispose(), (error) => error === errors[0]);
    await other.dispose();
  });

test('A-B-A selection aborts obsolete reads and rejects late callbacks without duplicate observation', async (t) => {
  const f = await fixture(t);
  await ready(f);
  const firstA = event<unknown>(),
    firstB = event<unknown>();
  let a = 0;
  f.answers.set('getChat', async (input) => {
    const current = (input as ChatCommands['getChat']['input']).target;
    if (current.conversationId === 'B') return firstB.promise;
    if (++a === 1) return firstA.promise;
    return { ...snapshot, conversation: { ...summary, title: 'Current A' } };
  });
  const callbacks: ((snapshot: ChatSnapshot) => void)[] = [];
  const originalWatch = f.chat.watch;
  f.chat.watch = (input, receive, error) => {
    callbacks.push(receive);
    return originalWatch(input, receive, error);
  };
  const openingA = f.controller.select(target),
    openingB = f.controller.select({ ...target, conversationId: 'B' });
  await f.controller.select(target);
  assert.equal(f.subscriptions, 1);
  assert.equal(f.controller.getSnapshot().snapshot!.conversation.title, 'Current A');
  callbacks[0]({ ...snapshot, conversation: { ...summary, title: 'Obsolete A callback' } });
  callbacks[1]({ ...snapshot, conversation: { ...summary, title: 'Obsolete B callback' } });
  firstA.resolve({ ...snapshot, conversation: { ...summary, title: 'Obsolete A read' } });
  firstB.resolve(snapshot);
  await Promise.all([openingA, openingB]);
  assert.equal(f.controller.getSnapshot().snapshot!.conversation.title, 'Current A');
  assert.equal(f.controller.getSnapshot().error, null);
  const signals = f.signals.get('getChat')!.slice(-3);
  assert.deepEqual(
    signals.map((signal) => signal.aborted),
    [true, true, false],
  );
});

test('generation replacement cancels held host reads and does not accept stale host/list state', async (t) => {
  const f = await fixture(t);
  await ready(f);
  const held = event<unknown>();
  f.answers.set('getChatHost', () => held.promise);
  const refreshing = f.controller.refresh();
  const old = f.signals.get('getChatHost')!.at(-1)!;
  f.answers.delete('getChatHost');
  f.publishConnection({
    state: 'connected',
    connectionId: 'replacement',
    profile,
    health: { ...context.host, protocol: 1, version: '0.1.0', capabilities: ['chat-v0'] },
  });
  await f.controller.refresh();
  assert(old.aborted);
  held.resolve({ ...context, cwd: '/obsolete', model: 'obsolete' });
  await refreshing;
  const host = f.controller.getSnapshot().host!;
  assert('cwd' in host);
  assert.equal(host.cwd, summary.cwd);
  assert.equal(f.controller.getSnapshot().error, null);
  assert.equal(f.subscriptions, 1);
  assert(!f.calls.some((call) => ['sendChat', 'stopChat'].includes(call.operation)));
});

test('detach leaves admitted mutation wait owned by model and preserves newer unsent text on settlement', async (t) => {
  const f = await fixture(t);
  await ready(f);
  const held = event<unknown>();
  f.answers.set('sendChat', () => held.promise);
  f.controller.setDraft('captured');
  const sending = f.controller.send();
  const pending = f.controller.getSnapshot().pending[0];
  f.controller.setDraft('newer unsent');
  await f.controller.detach();
  assert.equal(f.signals.get('sendChat')!.at(-1)!.aborted, false);
  held.resolve({
    target,
    requestId: pending.input.requestId,
    admission: 'admitted',
    submissionId: 'original',
  });
  await sending;
  assert.equal(f.controller.getSnapshot().draft, 'newer unsent');
  assert.equal(f.controller.getSnapshot().pending.length, 0);
  assert.equal(f.subscriptions, 0);
  assert(!f.calls.some((call) => call.operation === 'stopChat'));
});

test('failed watch acquisition remains observable through disposal and root cleanup without private diagnostics', async (t) => {
  const cleanup: (() => Promise<void>)[] = [];
  const f = await fixture({
    after: (close) => {
      cleanup.push(close);
    },
  });
  const expected = (error: unknown) =>
    ApplicationError.is(error) &&
    error.code === 'Unavailable' &&
    !error.message.includes('SYNTHETIC_PRIVATE_ACQUISITION_SENTINEL');
  t.after(async () => {
    for (const close of cleanup) await assert.rejects(close(), expected);
  });
  await ready(f);
  await f.controller.closeView();
  f.chat.watch = () => {
    throw new Error('SYNTHETIC_PRIVATE_ACQUISITION_SENTINEL');
  };
  await f.controller.select(target);
  assert.match(f.controller.getSnapshot().error!, /Unavailable/);
  assert(!f.controller.getSnapshot().error!.includes('SYNTHETIC_PRIVATE_ACQUISITION_SENTINEL'));
  await assert.rejects(f.controller.dispose(), expected);
});

test('synchronous watch callback can dispose before the close handle is returned without abandoning it', async (t) => {
  const f = await fixture(t);
  await ready(f);
  await f.controller.closeView();
  const entered = event(),
    held = event();
  let closes = 0,
    closing: Promise<void> | undefined;
  const off = f.controller.subscribe(() => {
    if (f.controller.getSnapshot().snapshot && !closing) closing = f.controller.dispose();
  });
  f.chat.watch = (_input, receive) => {
    receive(snapshot);
    return () => {
      closes++;
      entered.resolve();
      return held.promise;
    };
  };
  const opening = f.controller.select(target);
  await entered.promise;
  assert(closing);
  let settled = false;
  const finished = closing.then(() => {
    settled = true;
  });
  await f.root.runtime.runPromise(Effect.yieldNow);
  assert.equal(settled, false);
  held.resolve();
  await Promise.all([opening, finished]);
  assert.equal(closes, 1);
  off();
});

test('all observation releases are attempted and their typed cleanup failures reach root disposal', async (t) => {
  const cleanup: (() => Promise<void>)[] = [];
  const f = await fixture({
    after: (close) => {
      cleanup.push(close);
    },
  });
  let released = 0;
  f.connection.watch = () => async () => {
    released++;
    throw new ApplicationError({ code: 'Unavailable', message: 'Connection cleanup failed' });
  };
  f.chat.watch = () => async () => {
    released++;
    throw new ApplicationError({ code: 'Persistence', message: 'Chat cleanup failed' });
  };
  t.after(async () => {
    for (const close of cleanup)
      await assert.rejects(
        close(),
        /Connection cleanup failed.*Chat cleanup failed|Chat cleanup failed.*Connection cleanup failed/,
      );
  });
  await ready(f);
  await assert.rejects(
    f.controller.dispose(),
    /Connection cleanup failed.*Chat cleanup failed|Chat cleanup failed.*Connection cleanup failed/,
  );
  assert.equal(released, 2);
});

test('Create receipt does not wait for its view read or report obsolete view cancellation as mutation failure', async (t) => {
  const f = await fixture(t);
  await ready(f);
  await f.controller.closeView();
  const held = event<unknown>();
  f.answers.set('getChat', async (input) => {
    const current = (input as ChatCommands['getChat']['input']).target;
    return current.conversationId === target.conversationId
      ? held.promise
      : {
          ...snapshot,
          conversation: { ...summary, target: current, title: 'Selected B' },
        };
  });
  await f.controller.create('Captured creation');
  assert.equal(f.controller.getSnapshot().pending.length, 0);
  await f.controller.select({ ...target, conversationId: 'B' });
  held.resolve(snapshot);
  await f.root.runtime.runPromise(Effect.yieldNow);
  assert.equal(f.controller.getSnapshot().snapshot!.conversation.title, 'Selected B');
  assert.equal(f.controller.getSnapshot().error, null);
  assert.equal(f.calls.filter((call) => call.operation === 'createChat').length, 1);
});

test('repeated detach and disposal join a watch that is already closing outside its detached scope', async (t) => {
  const cleanup: (() => Promise<void>)[] = [];
  const f = await fixture({
    after: (close) => {
      cleanup.push(close);
    },
  });
  const held = event(),
    entered = event();
  const failure = new ApplicationError({ code: 'Persistence', message: 'Detached watch failed' });
  t.after(async () => {
    held.reject(failure);
    for (const close of cleanup) await assert.rejects(close(), /Detached watch failed/);
  });
  f.chat.watch = () => () => {
    entered.resolve();
    return held.promise;
  };
  await ready(f);
  const detaching = f.controller.detach();
  assert.strictEqual(f.controller.detach(), detaching);
  const detached = detaching.catch(() => {});
  await entered.promise;
  let settled = false;
  const closing = f.controller.dispose();
  const completed = closing
    .catch(() => {})
    .finally(() => {
      settled = true;
    });
  await f.root.runtime.runPromise(Effect.yieldNow);
  assert.equal(settled, false);
  held.reject(failure);
  await Promise.all([detached, completed]);
  await assert.rejects(closing, /Detached watch failed/);
});

test('detach during initial status cancels its read and ignores the old attachment callback after resume', async (t) => {
  const f = await fixture(t),
    held = event<unknown>();
  const stale: ConnectionSnapshot = {
    state: 'connected',
    connectionId: 'old-attachment',
    profile,
    health: { ...context.host, protocol: 1, version: '0.1.0', capabilities: ['chat-v0'] },
  };
  const original = f.connection.command,
    watch = f.connection.watch;
  const callbacks: ((state: ConnectionSnapshot) => void)[] = [];
  let initial = true,
    signal: AbortSignal | undefined;
  f.connection.watch = (receive, error) => {
    callbacks.push(receive);
    return watch(receive, error);
  };
  f.connection.command = async (operation, input, options) => {
    if (operation === 'getConnection' && initial) {
      initial = false;
      signal = options?.signal;
      return (await held.promise) as never;
    }
    return original(operation, input, options);
  };
  const starting = f.controller.start();
  await f.controller.detach();
  assert(signal?.aborted);
  await f.controller.start();
  callbacks[0](stale);
  held.resolve(stale);
  await starting;
  assert.equal(f.controller.getSnapshot().connection!.state, 'disconnected');
  assert.equal(f.controller.getSnapshot().host, null);
  assert.equal(f.controller.getSnapshot().error, null);
  assert(
    !f.calls.some((call) =>
      ['connect', 'createChat', 'sendChat', 'stopChat'].includes(call.operation),
    ),
  );
});

test('closing the selected view cannot consume the initial host/list refresh', async (t) => {
  const f = await fixture(t),
    held = event<unknown>(),
    fresh = event();
  await f.controller.start();
  let lists = 0;
  f.answers.set('listChats', async () => {
    if (++lists === 1) return held.promise;
    fresh.resolve();
    return { conversations: [summary], nextCursor: null };
  });
  await f.controller.connect();
  await f.controller.closeView();
  await fresh.promise;
  await f.root.runtime.runPromise(Effect.yieldNow);
  held.resolve({ conversations: [{ ...summary, title: 'Obsolete list' }], nextCursor: null });
  await f.root.runtime.runPromise(Effect.yieldNow);
  assert(f.controller.getSnapshot().host);
  assert.equal(f.controller.getSnapshot().chats[0].title, summary.title);
  assert.equal(f.controller.getSnapshot().selected, null);
  assert.equal(f.subscriptions, 0);
});

test('a connection watch supersedes an older initial status reply within the same attachment', async (t) => {
  const f = await fixture(t),
    held = event<unknown>();
  const original = f.connection.command;
  f.connection.command = async (operation, input, options) =>
    operation === 'getConnection'
      ? ((await held.promise) as never)
      : original(operation, input, options);
  const starting = f.controller.start();
  f.publishConnection({
    state: 'connected',
    connectionId: 'newer-observed-generation',
    profile,
    health: { ...context.host, protocol: 1, version: '0.1.0', capabilities: ['chat-v0'] },
  });
  await f.controller.refresh();
  held.resolve({ state: 'disconnected', connectionId: null, profile });
  await starting;
  assert.equal(f.controller.getSnapshot().connection!.connectionId, 'newer-observed-generation');
  assert(f.controller.getSnapshot().host);
  assert.equal(f.controller.getSnapshot().error, null);
  assert(!f.calls.some((call) => call.operation === 'connect'));
});

test('disposal fences reentrant snapshot listeners before releasing resources or emitting cleared view state', async (t) => {
  const f = await fixture(t);
  await ready(f);
  f.controller.setDraft('preserved before disposal');
  const saved = f.storage.value,
    writes = f.storage.writes;
  let reentered = false;
  f.controller.subscribe(() => {
    if (reentered) return;
    reentered = true;
    f.controller.setDraft('reentrant edit after disposal began');
    void f.controller.create('reentrant admission after disposal began');
  });
  await f.controller.dispose();
  assert.equal(f.storage.value, saved);
  assert.equal(f.storage.writes, writes);
  assert(!f.calls.some((call) => call.operation === 'createChat'));
  assert.equal(f.controller.getSnapshot().draft, 'preserved before disposal');
  assert.equal(f.controller.getSnapshot().host, null);
  assert.equal(f.controller.getSnapshot().snapshot, null);
});

test('a held Connect reply cannot resurrect a generation that its watch already lost', async (t) => {
  const f = await fixture(t),
    held = event<unknown>();
  await f.controller.start();
  const original = f.connection.command;
  f.connection.command = async (operation, input, options) =>
    operation === 'connect' ? ((await held.promise) as never) : original(operation, input, options);
  const connecting = f.controller.connect();
  const old: ConnectionSnapshot = {
    state: 'connected',
    connectionId: 'lost-generation',
    profile,
    health: { ...context.host, protocol: 1, version: '0.1.0', capabilities: ['chat-v0'] },
  };
  f.publishConnection(old);
  f.publishConnection({ state: 'disconnected', connectionId: null, profile });
  held.resolve(old);
  await connecting;
  assert.equal(f.controller.getSnapshot().connection!.state, 'disconnected');
  assert.equal(f.controller.getSnapshot().host, null);
});

test('explicit Disconnect drains the captured observation before invalidating its connection', async (t) => {
  const f = await fixture(t),
    entered = event(),
    held = event();
  const watch = f.chat.watch;
  f.chat.watch = (...args) => {
    const close = watch(...args);
    return async () => {
      entered.resolve();
      await held.promise;
      await close();
    };
  };
  await ready(f);
  const disconnecting = f.controller.disconnect();
  try {
    await entered.promise;
    assert.equal(f.calls.filter((call) => call.operation === 'disconnect').length, 0);
    assert.equal(f.subscriptions, 1);
    f.controller.setDraft('preserved while release is held');
    await f.controller.send();
    assert(!f.calls.some((call) => call.operation === 'sendChat'));
  } finally {
    held.resolve();
    await disconnecting;
  }
  assert.equal(f.subscriptions, 0);
  assert.equal(f.calls.filter((call) => call.operation === 'disconnect').length, 1);
  assert.equal(f.controller.getSnapshot().draft, 'preserved while release is held');
  assert.equal(f.controller.getSnapshot().connection!.state, 'disconnected');
  assert(!f.calls.some((call) => call.operation === 'stopChat'));
  await f.controller.connect();
  await turn();
  assert.equal(f.subscriptions, 1);
  await f.controller.dispose();
});

for (const failsClose of [false, true])
  test(`Disconnect drains a former selection observation through its actual ${failsClose ? 'failure' : 'success'}`, async (t) => {
    const cleanup: (() => Promise<void>)[] = [],
      f = await fixture({ after: (close) => cleanup.push(close) }),
      entered = event(),
      held = event(),
      watch = f.chat.watch;
    let first = true;
    f.chat.watch = (...args) => {
      const close = watch(...args);
      if (!first) return close;
      first = false;
      return async () => {
        entered.resolve();
        await held.promise;
        await close();
        assert.equal(f.controller.getSnapshot().connection?.state, 'connected');
        if (failsClose)
          throw new ApplicationError({
            code: 'Persistence',
            message: 'Former selection watch close failed',
          });
      };
    };
    t.after(async () => {
      held.resolve();
      for (const close of cleanup)
        if (failsClose) await assert.rejects(close(), /Former selection watch close failed/);
        else await close();
    });
    await ready(f);
    f.answers.set('getChat', async (input: ChatCommands['getChat']['input']) => ({
      ...snapshot,
      conversation: { ...summary, target: input.target },
    }));
    await f.controller.select({ ...target, conversationId: 'other-chat' });
    await entered.promise;
    const disconnecting = f.controller.disconnect();
    try {
      await turn();
      assert.equal(
        f.calls.filter((call) => call.operation === 'disconnect').length,
        0,
        'the already-closing observation still owns connectivity',
      );
    } finally {
      held.resolve();
      await disconnecting;
    }
    assert.equal(f.subscriptions, 0);
    assert.equal(
      f.calls.filter((call) => call.operation === 'disconnect').length,
      failsClose ? 0 : 1,
    );
    assert(!f.calls.some((call) => ['sendChat', 'stopChat'].includes(call.operation)));
    if (failsClose) {
      assert.match(f.controller.getSnapshot().error!, /Former selection watch close failed/);
      await assert.rejects(f.controller.dispose(), /Former selection watch close failed/);
    } else await f.controller.dispose();
  });

test('explicit Disconnect retains a failed observation release without invalidating connectivity', async (t) => {
  const cleanup: (() => Promise<void>)[] = [];
  const f = await fixture({ after: (close) => cleanup.push(close) });
  const failure = new ApplicationError({
    code: 'Persistence',
    message: 'Held watch release failed',
  });
  f.chat.watch = () => async () => {
    throw failure;
  };
  t.after(async () => {
    for (const close of cleanup) await assert.rejects(close(), /Held watch release failed/);
  });
  await ready(f);
  await f.controller.disconnect();
  assert.equal(f.calls.filter((call) => call.operation === 'disconnect').length, 0);
  assert.match(f.controller.getSnapshot().error!, /Held watch release failed/);
  await assert.rejects(f.controller.dispose(), /Held watch release failed/);
});

test('Disconnect fences reentrant Send before publishing unavailable readiness', async (t) => {
  const f = await fixture(t);
  await ready(f);
  f.controller.setDraft('preserved during Disconnect');
  let attempted = false;
  const off = f.controller.subscribe(() => {
    const state = f.controller.getSnapshot();
    if (!attempted && !state.ready && state.active.includes('disconnect')) {
      attempted = true;
      void f.controller.send();
    }
  });
  try {
    await f.controller.disconnect();
    await turn();
  } finally {
    off();
  }
  assert(attempted);
  assert(!f.calls.some((call) => call.operation === 'sendChat'));
  assert.equal(f.controller.getSnapshot().draft, 'preserved during Disconnect');
});

for (const changedId of [false, true])
  test(`Disconnect captured before observation close cannot invalidate a replacement owner (${changedId ? 'new' : 'same'} connection)`, async (t) => {
    const f = await fixture(t),
      watch = f.chat.watch;
    let replaced = false;
    f.chat.watch = (...args) => {
      const close = watch(...args);
      return async () => {
        await close();
        if (replaced) return;
        replaced = true;
        f.publishConnection({
          state: 'connected',
          connectionId: changedId
            ? 'replacement-during-close'
            : f.controller.getSnapshot().connection!.connectionId!,
          profile,
          health: { ...context.host, protocol: 1, version: '0.1.0', capabilities: ['chat-v0'] },
        });
      };
    };
    await ready(f);
    const originalId = f.controller.getSnapshot().connection!.connectionId;
    await f.controller.disconnect();
    await f.controller.refresh();
    assert.equal(f.calls.filter((call) => call.operation === 'disconnect').length, 0);
    assert.equal(
      f.controller.getSnapshot().connection!.connectionId,
      changedId ? 'replacement-during-close' : originalId,
    );
    assert.equal(f.controller.getSnapshot().ready, true);
  });

test('Hide without a replacement retains the model-owned admitted Disconnect', async (t) => {
  const f = await fixture(t),
    entered = event(),
    held = event(),
    watch = f.chat.watch;
  f.chat.watch = (...args) => {
    const close = watch(...args);
    return async () => {
      entered.resolve();
      await held.promise;
      await close();
    };
  };
  await ready(f);
  const disconnecting = f.controller.disconnect();
  let detaching: Promise<void> | undefined;
  try {
    await entered.promise;
    detaching = f.controller.detach();
    assert(f.controller.getSnapshot().active.includes('disconnect'));
    assert.equal(f.calls.filter((call) => call.operation === 'disconnect').length, 0);
  } finally {
    held.resolve();
    await Promise.all([disconnecting, detaching]);
  }
  assert.equal(f.calls.filter((call) => call.operation === 'disconnect').length, 1);
  assert.equal(f.subscriptions, 0);
  assert(!f.calls.some((call) => ['sendChat', 'stopChat'].includes(call.operation)));
  await f.controller.start();
  assert.equal(f.controller.getSnapshot().connection?.state, 'disconnected');
});

for (const changedId of [false, true])
  for (const hiddenReplacement of [false, true])
    test(`Hide then replacement protects its ${changedId ? 'new' : 'same'} connection from old Disconnect (${hiddenReplacement ? 'hidden' : 'attached'})`, async (t) => {
      const f = await fixture(t),
        entered = event(),
        held = event(),
        watch = f.chat.watch;
      let first = true;
      f.chat.watch = (...args) => {
        const close = watch(...args);
        if (!first) return close;
        first = false;
        return async () => {
          entered.resolve();
          await held.promise;
          await close();
        };
      };
      await ready(f);
      const previous = f.controller.getSnapshot().connection!;
      assert(previous.state === 'connected');
      const disconnecting = f.controller.disconnect();
      let detaching: Promise<void> | undefined;
      try {
        await entered.promise;
        detaching = f.controller.detach();
        if (changedId) f.publishConnection({ ...previous, connectionId: 'resumed-connection' });
        await f.controller.start();
        await f.controller.refresh();
        assert.equal(f.controller.getSnapshot().ready, true);
        if (hiddenReplacement) await f.controller.detach();
      } finally {
        held.resolve();
        await Promise.all([detaching, disconnecting]);
      }
      assert.equal(f.calls.filter((call) => call.operation === 'disconnect').length, 0);
      assert.equal(f.controller.getSnapshot().ready, !hiddenReplacement);
      assert.equal(
        f.controller.getSnapshot().connection!.connectionId,
        changedId ? 'resumed-connection' : previous.connectionId,
      );
    });

for (const at of ['close', 'publication'] as const)
  test(
    `R2 reentrant resume at Hide ${at} keeps replacement usable`,
    { timeout: 3000 },
    async (t) => {
      const f = await fixture(t);
      const connectionWatch = f.connection.watch;
      let connectionWatches = 0;
      f.connection.watch = (...args) => {
        const close = connectionWatch(...args);
        connectionWatches++;
        return async () => {
          await close();
          connectionWatches--;
        };
      };
      await ready(f);
      const original = f.chat.watch;
      let resuming: Promise<void> | undefined;
      if (at === 'close') {
        await f.controller.closeView();
        f.chat.watch = (...args) => {
          const close = original(...args);
          return () => {
            resuming ??= f.controller.start();
            return close();
          };
        };
        await f.controller.select(target);
      }
      let off = () => {};
      if (at === 'publication')
        off = f.controller.subscribe(() => {
          if (!f.controller.getSnapshot().ready && !resuming) resuming = f.controller.start();
        });
      try {
        await f.controller.detach();
        await resuming;
      } finally {
        off();
      }
      assert(resuming, 'resume callback must have run');
      await f.controller.refresh();
      assert.equal(f.controller.getSnapshot().ready, true, 'replacement remains ready');
      assert(f.controller.getSnapshot().host, 'replacement keeps host');
      assert(f.controller.getSnapshot().snapshot, 'replacement keeps selected snapshot');
      assert.equal(f.subscriptions, 1, 'replacement owns one watch');
      await f.controller.detach();
      assert.equal(f.subscriptions, 0, 'replacement remains attached so Hide can close it');
      assert.equal(connectionWatches, 0, 'replacement connection watch closes with its attachment');
    },
  );

test('Hide fences reentrant Send before publishing detached readiness', async (t) => {
  const f = await fixture(t);
  await ready(f);
  f.controller.setDraft('retained hidden draft');
  let attempted = false;
  const off = f.controller.subscribe(() => {
    if (!attempted && !f.controller.getSnapshot().ready) {
      attempted = true;
      void f.controller.send();
    }
  });
  try {
    await f.controller.detach();
  } finally {
    off();
  }
  assert(attempted);
  assert.equal(f.controller.getSnapshot().draft, 'retained hidden draft');
  assert(!f.calls.some((call) => ['sendChat', 'stopChat'].includes(call.operation)));
});

test('repeated Disconnect shares actual watch close and sends one command', async (t) => {
  const f = await fixture(t),
    entered = event(),
    held = event(),
    watch = f.chat.watch;
  let closes = 0;
  f.chat.watch = (...args) => {
    const close = watch(...args);
    return async () => {
      closes++;
      entered.resolve();
      await held.promise;
      await close();
    };
  };
  await ready(f);
  const disconnecting = f.controller.disconnect();
  try {
    await entered.promise;
    await f.controller.disconnect();
    assert.equal(closes, 1);
    assert.equal(f.calls.filter((call) => call.operation === 'disconnect').length, 0);
  } finally {
    held.resolve();
    await disconnecting;
  }
  assert.equal(f.calls.filter((call) => call.operation === 'disconnect').length, 1);
});

for (const stage of ['rpc', 'status'] as const)
  for (const changedId of [false, true])
    test(`obsolete Disconnect ${stage} failure cannot overwrite a replacement ${changedId ? 'new' : 'same'} connection`, async (t) => {
      const f = await fixture(t),
        entered = event(),
        held = event();
      await ready(f);
      const previous = f.controller.getSnapshot().connection!;
      assert(previous.state === 'connected');
      const original = f.connection.command;
      f.connection.command = async (operation, input, options) => {
        if (operation === 'disconnect') {
          const result = await original(operation, input, options);
          if (stage !== 'rpc') return result;
        } else if (operation !== 'getConnection' || stage !== 'status')
          return original(operation, input, options);
        entered.resolve();
        await held.promise;
        throw new ApplicationError({
          code: 'Unavailable',
          message: 'Obsolete Disconnect response failed',
        });
      };
      const disconnecting = f.controller.disconnect();
      try {
        await entered.promise;
        f.publishConnection({
          ...previous,
          connectionId: changedId ? 'R3-new-owner' : previous.connectionId,
        });
        await f.controller.refresh();
        assert.equal(f.controller.getSnapshot().ready, true);
        assert.equal(f.controller.getSnapshot().error, null);
        const replacement = f.controller.getSnapshot();
        held.resolve();
        await disconnecting;
        assert.equal(f.controller.getSnapshot().ready, true);
        assert.equal(f.controller.getSnapshot().connection, replacement.connection);
        assert.equal(f.subscriptions, 1);
        assert.equal(
          f.controller.getSnapshot().error,
          null,
          'old command error must not publish over a newer verified owner',
        );
      } finally {
        held.resolve();
        await disconnecting;
      }
    });

for (const stage of ['rpc', 'status'] as const)
  for (const hide of [false, true])
    test(`current Disconnect ${stage} failure remains visible ${hide ? 'across Hide' : 'while attached'}`, async (t) => {
      const f = await fixture(t),
        entered = event(),
        held = event();
      await ready(f);
      const original = f.connection.command;
      f.connection.command = async (operation, input, options) => {
        if (operation === 'disconnect') {
          const result = await original(operation, input, options);
          if (stage !== 'rpc') return result;
        } else if (operation !== 'getConnection' || stage !== 'status')
          return original(operation, input, options);
        entered.resolve();
        await held.promise;
        throw new ApplicationError({
          code: 'Unavailable',
          message: 'Current Disconnect response failed',
        });
      };
      const disconnecting = f.controller.disconnect();
      try {
        await entered.promise;
        if (hide) await f.controller.detach();
      } finally {
        held.resolve();
        await disconnecting;
      }
      assert.match(f.controller.getSnapshot().error!, /Current Disconnect response failed/);
      assert.equal(f.calls.filter((call) => call.operation === 'disconnect').length, 1);
      assert(!f.calls.some((call) => ['sendChat', 'stopChat'].includes(call.operation)));
    });

for (const changedId of [false, true])
  test(`Disconnect cannot migrate to a replacement from its admission publication (${changedId ? 'new' : 'same'} ID)`, async (t) => {
    const f = await fixture(t);
    await ready(f);
    const previous = f.controller.getSnapshot().connection!;
    assert(previous.state === 'connected');
    let replaced = false;
    const off = f.controller.subscribe(() => {
      if (!replaced && f.controller.getSnapshot().active.includes('disconnect')) {
        replaced = true;
        if (changedId) f.publishConnection({ ...previous, connectionId: 'admission-replacement' });
        else {
          void f.controller.detach();
          void f.controller.start();
        }
      }
    });
    try {
      await f.controller.disconnect();
      await f.controller.refresh();
    } finally {
      off();
    }
    assert(replaced);
    assert.equal(f.calls.filter((call) => call.operation === 'disconnect').length, 0);
    assert.equal(f.controller.getSnapshot().ready, true);
  });

test('a held Disconnect status read cannot replace a newer watched generation', async (t) => {
  const f = await fixture(t),
    held = event<unknown>(),
    entered = event();
  await ready(f);
  const original = f.connection.command;
  f.connection.command = async (operation, input, options) => {
    if (operation === 'getConnection') {
      entered.resolve();
      return (await held.promise) as never;
    }
    return original(operation, input, options);
  };
  const disconnecting = f.controller.disconnect();
  await entered.promise;
  f.publishConnection({
    state: 'connected',
    connectionId: 'replacement-after-disconnect',
    profile,
    health: { ...context.host, protocol: 1, version: '0.1.0', capabilities: ['chat-v0'] },
  });
  await f.controller.refresh();
  held.resolve({ state: 'disconnected', connectionId: null, profile });
  await disconnecting;
  assert.equal(f.controller.getSnapshot().connection!.connectionId, 'replacement-after-disconnect');
  assert(f.controller.getSnapshot().host);
});

test('serialized draft envelope bound blocks an unreloadable escaped-text write and retains the latest live edit', async (t) => {
  const f = await fixture(t);
  await ready(f);
  const value = '\u0001'.repeat(32768);
  for (let i = 0; i < 10; i++) {
    await f.controller.select({ ...target, conversationId: 'escaped-' + i });
    f.controller.setDraft(value);
    assert.equal(f.controller.getSnapshot().storageError, null);
  }
  await f.controller.select({ ...target, conversationId: 'escaped-overflow' });
  const saved = f.storage.value,
    writes = f.storage.writes;
  f.controller.setDraft(value);
  assert.equal(f.controller.preserve(), false);
  assert(f.controller.getSnapshot().storageError);
  assert.equal(f.controller.getSnapshot().draft, value);
  assert.equal(f.storage.value, saved);
  assert.equal(f.storage.writes, writes);
  assert.equal(JSON.parse(saved!).drafts.length, 10);
});

test('a failed local failure-note write retains original mutation uncertainty and cleanup evidence', async (t) => {
  const f = await fixture(t);
  await ready(f);
  f.controller.setDraft('original uncertain input');
  f.answers.set('sendChat', async () => {
    f.storage.fail = true;
    throw new ApplicationError({
      code: 'Uncertain',
      message: 'Controlled mutation outcome uncertainty',
    });
  });
  await f.controller.send();
  assert.match(
    f.controller.getSnapshot().error!,
    /^Uncertain: Controlled mutation outcome uncertainty.*Draft preservation failed/,
  );
  assert(f.controller.getSnapshot().storageError);
  assert.equal(f.controller.getSnapshot().pending.length, 1);
  const pending = f.controller.getSnapshot().pending[0];
  assert.equal(pending.operation, 'sendChat');
  assert.deepEqual(JSON.parse(f.storage.value!).pending[0].input, pending.input);
  assert.equal(f.calls.filter((call) => call.operation === 'sendChat').length, 1);
});

test('public context copies cannot retarget the model, its saved namespace or subsequent original requests', async (t) => {
  const f = await fixture(t);
  const copy = f.controller.context;
  copy.actorId = 'foreign-actor';
  copy.host.hostId = 'foreign-host';
  copy.host.storeId = 'foreign-store';
  assert.deepEqual(f.controller.context, context);
  assert.notStrictEqual(f.controller.context, f.controller.context);
  await ready(f);
  await f.controller.create('Original authority');
  const creation = f.calls.find((call) => call.operation === 'createChat')!;
  assert.deepEqual((creation.input as ChatCommands['createChat']['input']).session, context);
  assert.deepEqual(JSON.parse(f.storage.value!).session, context);
  assert.deepEqual(f.controller.context, context);
});

for (const typed of [true, false])
  test(`reentrant disposal retains ${typed ? 'typed' : 'unknown'} watch acquisition failure after the panel is removed`, async (t) => {
    const cleanup: (() => Promise<void>)[] = [];
    const f = await fixture({
      after: (close) => {
        cleanup.push(close);
      },
    });
    const failure = typed
      ? new ApplicationError({ code: 'Persistence', message: 'Reentrant watch acquisition failed' })
      : new Error('SYNTHETIC_PRIVATE_REENTRANT_ACQUISITION');
    const expected = (error: unknown) =>
      ApplicationError.is(error) &&
      error.code === (typed ? 'Persistence' : 'Unavailable') &&
      !error.message.includes('SYNTHETIC_PRIVATE_REENTRANT_ACQUISITION') &&
      (!typed || error === failure);
    t.after(async () => {
      for (const close of cleanup) await assert.rejects(close(), expected);
    });
    let closing: Promise<void> | undefined;
    f.controller.subscribe(() => {
      if (f.controller.getSnapshot().connection && !closing) closing = f.controller.dispose();
    });
    f.connection.watch = (receive) => {
      receive({ state: 'disconnected', connectionId: null, profile });
      throw failure;
    };
    await f.controller.start();
    assert(closing);
    await assert.rejects(closing, expected);
    assert.strictEqual(f.controller.dispose(), closing);
    await assert.rejects(f.controller.dispose(), expected);
    assert.equal(f.storage.writes, 0);
    assert.equal(f.controller.getSnapshot().error, null);
    assert(
      !f.calls.some((call) => ['createChat', 'sendChat', 'stopChat'].includes(call.operation)),
    );
  });

test('draft mentions persist with their text, drop when their text is deleted, and go out with Send', async (t) => {
  const storage = new Storage();
  const f = await fixture(t, storage);
  await ready(f);
  await f.controller.closeView();
  f.controller.setDraft('Compare @src/a.ts and @"docs/My notes.md" ', [
    { path: 'src/a.ts' },
    { path: 'docs/My notes.md' },
    { path: 'not/spelled.ts' },
  ]);
  assert.deepEqual(f.controller.getSnapshot().mentions, [
    { path: 'src/a.ts' },
    { path: 'docs/My notes.md' },
  ]);
  // Ordinary typing keeps the mentions its text still spells, as whole tokens.
  f.controller.setDraft('Compare @src/a.tsx and @"docs/My notes.md" ');
  assert.deepEqual(f.controller.getSnapshot().mentions, [{ path: 'docs/My notes.md' }]);
  f.controller.setDraft('Compare @src/a.ts and @"docs/My notes.md" ', [
    { path: 'src/a.ts' },
    { path: 'docs/My notes.md' },
  ]);
  f.controller.setDraft('Compare @src/a.ts and ');
  assert.deepEqual(f.controller.getSnapshot().mentions, [{ path: 'src/a.ts' }]);
  // Mentioning more files than a message carries leaves the draft as it was.
  const many = Array.from({ length: 33 }, (_, n) => ({ path: `f${n}` }));
  f.controller.setDraft(many.map((m) => `@${m.path}`).join(' '), many);
  assert.equal(f.controller.getSnapshot().draft, 'Compare @src/a.ts and ');
  assert.match(f.controller.getSnapshot().error ?? '', /at most 32 files/);
  const reopened = await f.root.make({
    chat: f.chat,
    connection: f.connection,
    context,
    storage,
  });
  assert.deepEqual(reopened.getSnapshot().mentions, [{ path: 'src/a.ts' }]);
  await f.controller.send();
  const send = f.calls.find((call) => call.operation === 'sendChat')!.input as {
    text: string;
    mentions?: unknown;
  };
  assert.equal(send.text, 'Compare @src/a.ts and ');
  assert.deepEqual(send.mentions, [{ path: 'src/a.ts' }]);
  assert.deepEqual(f.controller.getSnapshot().mentions, []);
  // A reply in the open chat carries its own mentions.
  f.controller.setDraft('Now @b.ts', [{ path: 'b.ts' }]);
  await f.controller.send();
  const reply = f.calls.filter((call) => call.operation === 'sendChat')[1]!.input as {
    mentions?: unknown;
  };
  assert.deepEqual(reply.mentions, [{ path: 'b.ts' }]);
  f.controller.setDraft('No mentions');
  await f.controller.send();
  const plain = f.calls.filter((call) => call.operation === 'sendChat')[2]!.input as object;
  assert(!('mentions' in plain));
});

test('file search asks the host for the open chat, a new chat folder, or the host folder', async (t) => {
  const f = await fixture(t);
  await f.controller.start();
  await f.controller.connect();
  await turn();
  await assert.rejects(f.controller.findFiles('a'), { code: 'Unavailable' });
  f.answers.set('getChatHost', async () => ({
    ...context,
    cwd: summary.cwd,
    model: summary.model,
    features: ['chat-files-v1'],
  }));
  await f.controller.refresh();
  assert.equal(f.controller.canFindFiles, true);
  const reply = { query: 'a', matches: [{ path: 'a.ts', positions: [0] }], partial: false };
  f.answers.set('findChatFiles', async () => reply);
  assert.deepEqual(await f.controller.findFiles('a'), reply);
  assert.deepEqual(f.calls.at(-1)!.input, { session: context, cwd: summary.cwd, query: 'a' });
  await f.controller.findFiles('a', { cwd: '/chosen' });
  assert.deepEqual(f.calls.at(-1)!.input, { session: context, cwd: '/chosen', query: 'a' });
  await f.controller.select(target);
  await f.controller.findFiles('a', { cwd: '/ignored' });
  assert.deepEqual(f.calls.at(-1)!.input, { target, query: 'a' });
  const abort = new AbortController();
  f.answers.set(
    'findChatFiles',
    (input: unknown) =>
      new Promise((_, reject) =>
        f.signals
          .get('findChatFiles')!
          .at(-1)!
          .addEventListener('abort', () => reject(input)),
      ),
  );
  const cancelled = f.controller.findFiles('b', { signal: abort.signal });
  await turn();
  abort.abort();
  await assert.rejects(cancelled);
});

test('a file picker shows only the latest answer and cancels the searches before it', async () => {
  const { ChatFileSearch } = await import('@moonbase/application/chat');
  const calls: {
    query: string;
    cwd?: string;
    signal: AbortSignal;
    settle: (v: unknown) => void;
    fail: (e: unknown) => void;
  }[] = [];
  const search = new ChatFileSearch(
    (query, options) =>
      new Promise((settle, fail) =>
        calls.push({
          query,
          cwd: options.cwd,
          signal: options.signal,
          settle: settle as never,
          fail,
        }),
      ),
  );
  let notified = 0;
  search.subscribe(() => notified++);
  search.search('a', '/work');
  search.search('ab', '/work');
  assert.equal(calls[0]!.signal.aborted, true);
  assert.equal(calls[1]!.cwd, '/work');
  assert.equal(search.getSnapshot().busy, true);
  calls[0]!.settle({ query: 'a', matches: [{ path: 'stale.ts', positions: [] }], partial: false });
  calls[1]!.settle({ query: 'ab', matches: [{ path: 'ab.ts', positions: [0, 1] }], partial: true });
  await turn();
  assert.deepEqual(search.getSnapshot(), {
    query: 'ab',
    matches: [{ path: 'ab.ts', positions: [0, 1] }],
    partial: true,
    busy: false,
    error: null,
  });
  search.search('abc');
  calls[2]!.fail(new ApplicationError({ code: 'Unavailable', message: 'No ripgrep or Git.' }));
  await turn();
  assert.equal(search.getSnapshot().error, 'No ripgrep or Git.');
  assert.deepEqual(search.getSnapshot().matches, []);
  search.search('x');
  search.dispose();
  assert.equal(calls[3]!.signal.aborted, true);
  assert.equal(search.getSnapshot().query, null);
  const before = notified;
  search.search('y');
  assert.equal(calls.length, 4);
  assert.equal(notified, before);
});

test('listing reads every page, and a first listing marks what is already there as seen', async (t) => {
  const f = await fixture(t);
  const chat = (id: string, at: string) => ({
    ...summary,
    target: { ...context, conversationId: id },
    activity: { state: 'idle' as const, at },
  });
  f.answers.set('listChats', async (input: { cursor?: string }) =>
    input.cursor === 'page-2'
      ? { conversations: [chat('old', '2026-11-07T09:00:00Z')], nextCursor: null }
      : { conversations: [chat('new', '2026-11-07T10:00:00Z')], nextCursor: 'page-2' },
  );
  await f.controller.start();
  await f.controller.connect();
  const state = f.controller.getSnapshot();
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
  f.controller.markSeen('old', '2026-11-07T11:00:00Z');
  f.controller.markSeen('old', '2026-11-07T08:00:00Z');
  assert.deepEqual(f.controller.getSnapshot().seen?.[0], {
    conversationId: 'old',
    at: '2026-11-07T11:00:00Z',
  });
  assert.deepEqual(JSON.parse(f.storage.value!).seen[0], {
    conversationId: 'old',
    at: '2026-11-07T11:00:00Z',
  });
});

test('a background reload lists again without clearing an error or Refresh state', async (t) => {
  const f = await fixture(t);
  await f.controller.start();
  await f.controller.reloadChats();
  assert.equal(f.calls.filter((c) => c.operation === 'listChats').length, 0);
  await f.controller.connect();
  f.answers.set('listChats', async () => {
    throw failure();
  });
  await f.controller.reloadChats();
  // A failed background reload keeps the last list and reports nothing.
  assert.equal(f.controller.getSnapshot().chats.length, 1);
  assert.equal(f.controller.getSnapshot().error, null);
  f.answers.set('listChats', async () => ({
    conversations: [{ ...summary, title: 'Renamed' }],
    nextCursor: null,
  }));
  await f.controller.reloadChats();
  assert.equal(f.controller.getSnapshot().chats[0].title, 'Renamed');
  assert.deepEqual(f.controller.getSnapshot().active, []);
});

test('settle updates the listed chat and the open snapshot from the host reply, then lists again', async (t) => {
  const f = await fixture(t);
  const activity = { state: 'idle' as const, at: '2026-01-02T00:00:00Z' };
  // The host lists the chat as settled once a settle reply has been sent.
  let hostSettledAt: string | undefined;
  f.answers.set('listChats', async () => ({
    conversations: [
      { ...summary, activity, ...(hostSettledAt ? { settledAt: hostSettledAt } : {}) },
    ],
    nextCursor: null,
  }));
  await ready(f);
  await turn();
  const listings = () => f.calls.filter((call) => call.operation === 'listChats').length;
  const settledAt = '2026-02-01T00:00:00Z';
  f.answers.set('settleChat', async (input: ChatCommands['settleChat']['input']) => {
    hostSettledAt = input.settled ? settledAt : undefined;
    return hostSettledAt ? { ...summary, settledAt } : summary;
  });
  let before = listings();
  await f.controller.settle(target, true);
  assert.deepEqual(
    f.calls.filter((call) => call.operation === 'settleChat').map((call) => call.input),
    [{ target, settled: true }],
  );
  let state = f.controller.getSnapshot();
  assert.equal(state.error, null);
  // The listing keeps its activity, which only listings carry.
  assert.deepEqual(state.chats[0], { ...summary, settledAt, activity });
  assert.equal(state.snapshot?.conversation.settledAt, settledAt);
  // A reload follows, so a listing begun before the reply can't leave the list behind it.
  await f.controller.reloadChats();
  assert(listings() > before);
  assert.deepEqual(f.controller.getSnapshot().chats[0], { ...summary, settledAt, activity });
  before = listings();
  await f.controller.settle(target, false);
  state = f.controller.getSnapshot();
  assert.equal('settledAt' in state.chats[0]!, false);
  assert.equal(state.snapshot?.conversation.settledAt, undefined);
  assert.deepEqual(state.active, []);
  await f.controller.reloadChats();
  assert(listings() > before);
  // A refusal is shown and changes nothing.
  f.answers.set('settleChat', async () => {
    throw new ApplicationError({ code: 'Unauthorized', message: 'Not yours.' });
  });
  await f.controller.settle(target, true);
  state = f.controller.getSnapshot();
  assert.equal(state.error, 'Unauthorized: Not yours.');
  assert.equal(state.chats[0]!.settledAt, undefined);
  // Another context's chat is refused before reaching the host.
  const count = f.calls.length;
  await f.controller.settle({ ...target, actorId: 'stranger' }, true);
  assert.equal(f.calls.length, count);
  assert.match(f.controller.getSnapshot().error!, /another context/);
});

test('settle needs a connected host', async (t) => {
  const f = await fixture(t);
  await f.controller.start();
  await f.controller.settle(target, true);
  assert(!f.calls.some((call) => call.operation === 'settleChat'));
  assert.match(f.controller.getSnapshot().error!, /^Unavailable/);
});

test('a draft mention the saved format rejects is refused without blocking storage, Send or Quit', async (t) => {
  const { formatChatMention } = await import('@moonbase/contracts/chat');
  const f = await fixture(t);
  await ready(f);
  f.controller.setDraft('Before');
  for (const path of [
    'a"b.ts',
    'a\\b.ts',
    'x\u0001.ts',
    '../up.ts',
    'a/./b.ts',
    'd/'.repeat(600),
  ]) {
    const value = `Look at ${formatChatMention(path)} `;
    f.controller.setDraft(value, [{ path }]);
    const state = f.controller.getSnapshot();
    assert.match(state.error ?? '', /relative path/, path);
    assert.equal(state.storageError, null);
    assert.equal(state.draft, 'Before');
    assert.deepEqual(state.mentions, []);
  }
  assert.equal(JSON.parse(f.storage.value!).drafts[0].text, 'Before');
  assert.equal(f.controller.preserve(), true);
  f.controller.setDraft('Now @ok.ts', [{ path: 'ok.ts' }]);
  assert.equal(f.controller.getSnapshot().storageError, null);
  await f.controller.send();
  const send = f.calls.find((call) => call.operation === 'sendChat')!.input as {
    mentions?: unknown;
  };
  assert.deepEqual(send.mentions, [{ path: 'ok.ts' }]);
  assert.equal(f.controller.preserve(), true);
});

test('a Send in flight is dispatching, and only an uncertain one stays pending for the Ready list', async (t) => {
  const { groupChatsByActivity } = await import('@moonbase/application/chat');
  const f = await fixture(t);
  await ready(f);
  const reasons = () => {
    const state = f.controller.getSnapshot();
    return groupChatsByActivity({
      chats: [summary],
      pending: state.pending,
      dispatching: state.dispatching,
    }).ready.map((row) => row.reason);
  };
  const reply = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  f.answers.set('sendChat', async () => {
    entered.resolve();
    await reply.promise;
    throw failure();
  });
  let sawReservation = false;
  f.controller.subscribe(() => {
    const state = f.controller.getSnapshot();
    // The Send is counted as in flight before its reservation is published.
    if (state.pending.length && !sawReservation) {
      sawReservation = true;
      assert.deepEqual(state.dispatching, [state.pending[0]!.input.requestId]);
    }
  });
  f.controller.setDraft('Hello');
  const sending = f.controller.send();
  await entered.promise;
  assert(sawReservation);
  const id = f.controller.getSnapshot().pending[0]!.input.requestId;
  assert.deepEqual(f.controller.getSnapshot().dispatching, [id]);
  assert.deepEqual(reasons(), []);
  reply.resolve();
  await sending;
  assert.deepEqual(f.controller.getSnapshot().dispatching, []);
  assert.equal(f.controller.getSnapshot().pending.length, 1);
  assert.deepEqual(reasons(), ['unconfirmed']);
  // An explicit retry is in flight again until it is admitted.
  const retried = Promise.withResolvers<void>();
  f.answers.set('sendChat', async (input: ChatCommands['sendChat']['input']) => {
    await retried.promise;
    return { target, requestId: input.requestId, admission: 'admitted', submissionId: 's' };
  });
  const retrying = f.controller.retry(id);
  await turn();
  assert.deepEqual(f.controller.getSnapshot().dispatching, [id]);
  assert.deepEqual(reasons(), []);
  retried.resolve();
  await retrying;
  assert.deepEqual(f.controller.getSnapshot().dispatching, []);
  assert.deepEqual(f.controller.getSnapshot().pending, []);
});

test('a new chat’s first message is in flight from the moment its Create is answered', async (t) => {
  const f = await fixture(t);
  await ready(f);
  await f.controller.closeView();
  const reply = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  f.answers.set('sendChat', async (input: ChatCommands['sendChat']['input']) => {
    entered.resolve();
    await reply.promise;
    return { target, requestId: input.requestId, admission: 'admitted', submissionId: 's' };
  });
  let checked = 0;
  f.controller.subscribe(() => {
    const state = f.controller.getSnapshot();
    for (const pending of state.pending)
      if (pending.operation === 'sendChat') {
        checked++;
        assert(state.dispatching.includes(pending.input.requestId));
      }
  });
  f.controller.setDraft('First message');
  const sending = f.controller.send();
  await entered.promise;
  assert.equal(f.controller.getSnapshot().pending[0]!.operation, 'sendChat');
  reply.resolve();
  await sending;
  assert(checked > 0);
  assert.deepEqual(f.controller.getSnapshot().dispatching, []);
});

/** A host listing one chat per page, `page-chat-0` newest; `update` changes a chat's summary. */
function pagedChats(f: Awaited<ReturnType<typeof fixture>>, pages: number) {
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
    return {
      conversations: [chat],
      nextCursor: page + 1 < pages ? `page-${page + 1}` : null,
    };
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
const shownIds = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.controller.getSnapshot().chats.map((chat) => chat.target.conversationId);
const pageIds = (count: number) => Array.from({ length: count }, (_, n) => 'page-chat-' + n);
const showOlder = async (f: Awaited<ReturnType<typeof fixture>>, pages = 16) => {
  await f.controller.start();
  await f.controller.connect();
  await f.controller.refresh();
  assert.equal(shownIds(f).length, Math.min(pages, 16));
};

test('a background reload reads again through the older chats Show older added', async (t) => {
  const f = await fixture(t);
  const list = pagedChats(f, 20);
  list.update(17, { activity: { state: 'running', at: '2026-11-07T10:00:00Z' } });
  await showOlder(f);
  assert.equal(f.controller.getSnapshot().nextChats, 'page-16');
  await f.controller.moreChats();
  await f.controller.moreChats();
  assert.deepEqual(shownIds(f), pageIds(18));
  assert.equal(f.controller.getSnapshot().nextChats, 'page-18');
  assert.equal(f.controller.getSnapshot().chats[17]!.activity?.state, 'running');
  // The older chat finishes on the host, and the newest is renamed.
  list.update(17, { activity: { state: 'idle', at: '2026-11-07T10:05:00Z' } });
  list.update(0, { title: 'Renamed' });
  const before = list.calls;
  await f.controller.reloadChats();
  assert.equal(list.calls - before, 18);
  assert.deepEqual(shownIds(f), pageIds(18));
  assert.deepEqual(f.controller.getSnapshot().chats[17]!.activity, {
    state: 'idle',
    at: '2026-11-07T10:05:00Z',
  });
  assert.equal(f.controller.getSnapshot().chats[0]!.title, 'Renamed');
  assert.equal(f.controller.getSnapshot().nextChats, 'page-18');
  await f.controller.moreChats();
  assert.equal(shownIds(f).at(-1), 'page-chat-18');
  // A creation keeps the older chats too.
  f.answers.set('createChat', async (input: ChatCommands['createChat']['input']) => ({
    requestId: input.requestId,
    conversation: { ...summary, target: { ...context, conversationId: 'created' } },
  }));
  await f.controller.create('Created');
  assert.deepEqual(shownIds(f), ['created', ...pageIds(19)]);
});

test('a background reload reads a bounded depth and keeps the chats past it as listed', async (t) => {
  const f = await fixture(t);
  const list = pagedChats(f, 70);
  await showOlder(f);
  for (let page = 16; page < 68; page++) await f.controller.moreChats();
  assert.deepEqual(shownIds(f), pageIds(68));
  list.update(63, { title: 'Reached' });
  list.update(66, { title: 'Past the bound' });
  const before = list.calls;
  await f.controller.reloadChats();
  assert.equal(list.calls - before, 64);
  assert.deepEqual(shownIds(f), pageIds(68));
  assert.equal(f.controller.getSnapshot().chats[63]!.title, 'Reached');
  assert.equal(f.controller.getSnapshot().chats[66]!.title, 'Chat 66');
  assert.equal(f.controller.getSnapshot().nextChats, 'page-68');
});

test('a chat created while a complete listing reloads stays first', async (t) => {
  const f = await fixture(t);
  const list = pagedChats(f, 3);
  await showOlder(f, 3);
  assert.equal(f.controller.getSnapshot().nextChats, null);
  const release = list.hold();
  const reloading = f.controller.reloadChats();
  await turn();
  f.answers.set('createChat', async (input: ChatCommands['createChat']['input']) => ({
    requestId: input.requestId,
    conversation: { ...summary, target: { ...context, conversationId: 'created' } },
  }));
  await f.controller.create('Created');
  assert.deepEqual(shownIds(f), ['created', ...pageIds(3)]);
  release();
  await reloading;
  assert.deepEqual(shownIds(f), ['created', ...pageIds(3)]);
  assert.equal(f.controller.getSnapshot().nextChats, null);
});

test('a reload asked for during another joins it, and one asked for the latest list runs after it', async (t) => {
  const f = await fixture(t);
  await f.controller.start();
  await f.controller.connect();
  let listings = 0,
    title = 'First',
    held = Promise.withResolvers<void>();
  f.answers.set('listChats', async () => {
    listings++;
    const current = title;
    await held.promise;
    return { conversations: [{ ...summary, title: current }], nextCursor: null };
  });
  // Timer ticks during a slow reload join it rather than queueing reloads back to back.
  const first = f.controller.reloadChats();
  await turn();
  const tick = f.controller.reloadChats();
  held.resolve();
  await Promise.all([first, tick]);
  assert.equal(listings, 1);
  held = Promise.withResolvers<void>();
  const slow = f.controller.reloadChats();
  await turn();
  title = 'After the run ended';
  const latest = f.controller.reloadChats({ latest: true });
  const again = f.controller.reloadChats({ latest: true });
  const ticked = f.controller.reloadChats();
  held.resolve();
  await Promise.all([slow, latest, again, ticked]);
  assert.equal(listings, 3);
  assert.equal(f.controller.getSnapshot().chats[0]!.title, 'After the run ended');
  await f.controller.reloadChats();
  assert.equal(listings, 4);
});
