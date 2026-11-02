import type { TaskId, ConversationId } from '@earendil-works/pi-durable';
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedRuntime } from 'effect';
import { ApplicationError } from '@moonbase/application/client';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { makeChatClient } from '@moonbase/application/runtime-client';
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTool,
  defineDocFamily,
  type Registry,
} from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { NodeSqliteDatabase, openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { readFile } from 'node:fs/promises';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { PiRuntimeLive } from '../src/index.ts';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { Effect, Layer } from 'effect';
import { runApplicationEffect } from '@moonbase/application/effect-client';
import type { ChatSnapshot } from '@moonbase/application/chat-client';

const session = { host: { hostId: 'test-host', storeId: 'test-store' }, actorId: 'personal' };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until<T>(get: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = await get();
    if (ready(value)) return value;
    await delay(10);
  }
  throw Error('Condition did not settle.');
}
async function fixture(
  t: { after: (fn: () => Promise<void>) => void },
  registry?: Registry,
  fauxOptions: Parameters<typeof fauxProvider>[0] = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'moonbase-pi-')),
    faux = fauxProvider({ tokensPerSecond: 100000, ...fauxOptions }),
    models = createModels();
  models.setProvider(faux.provider);
  const config = {
    ...session,
    cwd: directory,
    databasePath: join(directory, 'chat.sqlite'),
    model: { provider: faux.provider.id, modelId: faux.getModel().id },
    models,
    registry,
  };
  let runtime = ManagedRuntime.make(PiRuntimeLive(config));
  t.after(async () => {
    try {
      await runtime.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  return {
    faux,
    config,
    get client() {
      return makeChatClient(runtime);
    },
    async restart() {
      await runtime.dispose();
      runtime = ManagedRuntime.make(PiRuntimeLive(config));
    },
    async dispose() {
      await runtime.dispose();
    },
    async create(requestId = 'create') {
      return (
        await makeChatClient(runtime).command('createChat', {
          session,
          requestId,
          title: 'Saved chat',
        })
      ).conversation.target;
    },
  };
}
test('atomic creation retries and actor/request immutable binding survive restart', async (t) => {
  const f = await fixture(t);
  const target = await f.create();
  assert.deepEqual(await f.create(), target);
  await assert.rejects(
    f.client.command('createChat', { session, requestId: 'create', title: 'Changed' }),
    { code: 'InvalidInput' },
  );
  const list = await f.client.command('listChats', { session });
  assert.equal(list.conversations.length, 1);
  await f.restart();
  assert.deepEqual(await f.create(), target);
  assert.equal(f.faux.state.callCount, 0);
  await assert.rejects(
    f.client.command('listChats', { session: { ...session, actorId: 'other' } }),
    { code: 'Unauthorized' },
  );
});
test('duplicate/lost Send, read-only lookup, restart and cross-operation reuse never resend', async (t) => {
  const f = await fixture(t),
    target = await f.create();
  f.faux.setResponses([fauxAssistantMessage('Hello')]);
  const input = { target, requestId: 'send', text: 'Question' };
  const receipts = await Promise.all([
    f.client.command('sendChat', input),
    f.client.command('sendChat', input),
  ]);
  assert.deepEqual(receipts[0], receipts[1]);
  await until(
    () => f.client.command('getChat', { target }),
    (s) => s.run === null && s.entries.some((e) => e.text === 'Hello'),
  );
  assert.equal(f.faux.state.callCount, 1);
  await assert.rejects(f.client.command('sendChat', { ...input, text: 'changed' }), {
    code: 'InvalidInput',
  });
  await assert.rejects(f.client.command('sendChat', { ...input, requestId: 'create' }), {
    code: 'InvalidInput',
  });
  assert.equal(await f.client.command('getChatSend', { target, requestId: 'unknown' }), null);
  await f.restart();
  assert.deepEqual(
    await f.client.command('getChatSend', { target, requestId: 'send' }),
    receipts[0],
  );
  assert.deepEqual(await f.client.command('sendChat', input), receipts[0]);
  assert.equal(f.faux.state.callCount, 1);
});
test('busy reservation stays visible; view unsubscribe and caller cancellation never Stop admitted work', async (t) => {
  const f = await fixture(t),
    target = await f.create();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  t.after(async () => release());
  f.faux.setResponses([
    async () => {
      await gate;
      return fauxAssistantMessage('Detached completion');
    },
  ]);
  await f.client.command('sendChat', { target, requestId: 'one', text: 'Start' });
  const events: ChatSnapshot[] = [];
  const off = f.client.watch(
    { target },
    (s) => events.push(s),
    (error) => {
      throw error;
    },
  );
  await until(
    () => f.client.command('getChat', { target }),
    (s) => !!s.run,
  );
  await off();
  const count = events.length;
  await assert.rejects(f.client.command('sendChat', { target, requestId: 'two', text: 'Busy' }), {
    code: 'Conflict',
  });
  assert.equal(
    (await f.client.command('getChatSend', { target, requestId: 'two' }))?.admission,
    'reserved',
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    f.client.command(
      'sendChat',
      { target, requestId: 'never', text: 'Never' },
      { signal: abort.signal },
    ),
    { code: 'Cancelled' },
  );
  assert.equal(await f.client.command('getChatSend', { target, requestId: 'never' }), null);
  release();
  await until(
    () => f.client.command('getChat', { target }),
    (s) => s.run === null && s.entries.some((e) => e.text === 'Detached completion'),
  );
  assert.equal(events.length, count);
  assert.equal(f.faux.state.callCount, 1);
});
test('exact task Stop settles and cannot abort a later task', async (t) => {
  const f = await fixture(t),
    target = await f.create();
  f.faux.setResponses([fauxAssistantMessage('a'.repeat(10000))]);
  await f.client.command('sendChat', { target, requestId: 'one', text: 'First' });
  const current = await until(
    () => f.client.command('getChat', { target }),
    (s) => !!s.run,
  );
  const stop = current.run!.stop;
  const result = await f.client.command('stopChat', { stop, requestId: 'stop' });
  assert.ok(['stopped', 'terminal', 'pending'].includes(result.outcome));
  await until(
    () => f.client.command('getChat', { target }),
    (s) => s.run === null,
  );
  f.faux.setResponses([fauxAssistantMessage('Later')]);
  await f.client.command('sendChat', { target, requestId: 'two', text: 'Second' });
  const old = await f.client.command('stopChat', { stop, requestId: 'stop' });
  assert.ok(['terminal', 'superseded'].includes(old.outcome));
  await until(
    () => f.client.command('getChat', { target }),
    (s) => s.run === null && s.entries.some((e) => e.text === 'Later'),
  );
  await assert.rejects(
    f.client.command('stopChat', { stop: { ...stop, taskId: null }, requestId: 'stop' }),
    { code: 'InvalidInput' },
  );
});

for (const admitted of [false, true])
  test(`interrupted ${admitted ? 'admitted binding' : 'reservation'} recovers without implicit resubmission`, async (t) => {
    const original = Harness.open;
    let fail = true;
    mock.method(Harness, 'open', async (...args: Parameters<typeof original>) => {
      const harness = await original(...args),
        get = harness.conversation.bind(harness);
      harness.conversation = async (...values: Parameters<typeof get>) => {
        const conversation = await get(...values);
        if (conversation) {
          const submit = conversation.submit.bind(conversation);
          conversation.submit = async (...input: Parameters<typeof submit>) => {
            if (fail) {
              fail = false;
              if (admitted) await submit(...input);
              throw Error('Controlled lost admission response');
            }
            return submit(...input);
          };
        }
        return conversation;
      };
      return harness;
    });
    t.after(async () => mock.restoreAll());
    const f = await fixture(t),
      target = await f.create();
    f.faux.setResponses([fauxAssistantMessage('Once')]);
    const input = { target, requestId: 'lost', text: 'Retained' };
    await assert.rejects(f.client.command('sendChat', input), { code: 'Uncertain' });
    await f.restart();
    const receipt = await f.client.command('getChatSend', { target, requestId: 'lost' });
    assert.equal(receipt?.admission, admitted ? 'admitted' : 'reserved');
    const before = f.faux.state.callCount;
    await f.client.command('getChat', { target });
    await f.client.command('listChats', { session });
    assert.equal(f.faux.state.callCount, before);
    if (!admitted) {
      assert.equal(before, 0);
      assert.equal((await f.client.command('getChat', { target })).state, 'uncertain');
    }
    assert.equal((await f.client.command('sendChat', input)).admission, 'admitted');
    await until(
      () => f.client.command('getChat', { target }),
      (s) => s.run === null && s.entries.some((e) => e.text === 'Once'),
    );
    assert.equal(f.faux.state.callCount, 1);
  });
test('caller cancellation after persisted admission closes only its wait', async (t) => {
  const original = Harness.open;
  let entered!: () => void, release!: () => void;
  const pending = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  mock.method(Harness, 'open', async (...args: Parameters<typeof original>) => {
    const harness = await original(...args),
      get = harness.conversation.bind(harness);
    harness.conversation = async (...values: Parameters<typeof get>) => {
      const conversation = await get(...values);
      if (conversation) {
        const submit = conversation.submit.bind(conversation);
        conversation.submit = async (...input: Parameters<typeof submit>) => {
          const receipt = await submit(...input);
          entered();
          await gate;
          return receipt;
        };
      }
      return conversation;
    };
    return harness;
  });
  t.after(async () => {
    release();
    mock.restoreAll();
  });
  const f = await fixture(t),
    target = await f.create();
  f.faux.setResponses([fauxAssistantMessage('Continued')]);
  const abort = new AbortController();
  const input = { target, requestId: 'cancelled-wait', text: 'Keep running' },
    call = f.client.command('sendChat', input, { signal: abort.signal });
  await pending;
  abort.abort();
  await assert.rejects(call, { code: 'Cancelled' });
  release();
  await until(
    () => f.client.command('getChat', { target }),
    (s) => s.run === null && s.entries.some((e) => e.text === 'Continued'),
  );
  assert.equal(
    (await f.client.command('getChatSend', { target, requestId: input.requestId }))?.admission,
    'admitted',
  );
  assert.equal(f.faux.state.callCount, 1);
});
test('counted tools publish bounded progress; old task Stop cannot follow generation handover', async (t) => {
  let tools = 0,
    release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: 'controlled',
      tools: [
        defineTool({
          name: 'counted',
          description: 'Controlled counter',
          parameters: Type.Object({}),
          execute: async (_, api, ctx) => {
            tools++;
            api.output('😀\\"\n'.repeat(5000));
            await api.details({ privateUnused: 'x'.repeat(20000) }, ctx);
            await Promise.race([
              gate,
              new Promise<void>((resolve) => {
                if (ctx.abortSignal?.aborted) return resolve();
                ctx.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
              }),
            ]);
            return { output: [{ type: 'text', text: 'Counted' }] };
          },
        }),
      ],
    }),
  );
  const f = await fixture(t, registry),
    target = await f.create();
  t.after(async () => release());
  let next!: () => void, finish!: () => void;
  const entered = new Promise<void>((r) => (next = r)),
    done = new Promise<void>((r) => (finish = r));
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall('counted', {}), { stopReason: 'toolUse' }),
    async () => {
      next();
      await done;
      return fauxAssistantMessage('Final');
    },
  ]);
  await f.client.command('sendChat', { target, requestId: 'tools', text: 'Run counted tool' });
  const active = await until(
    () => f.client.command('getChat', { target }),
    (s) => !!s.run?.tools.some((t) => t.text.length),
  );
  const old = active.run!.stop;
  assert.equal(tools, 1);
  assert(
    active.run!.tools.every((t) => Buffer.byteLength(t.text) <= 4096 && t.text.isWellFormed()),
  );
  assert(Buffer.byteLength(JSON.stringify(active)) <= 256 * 1024);
  release();
  await entered;
  const successor = await f.client.command('getChat', { target });
  assert.notEqual(successor.run!.stop.taskId, old.taskId);
  assert.equal(successor.run!.stop.submissionId, old.submissionId);
  const outcome = await f.client.command('stopChat', { stop: old, requestId: 'old-task' });
  assert.ok(['terminal', 'superseded'].includes(outcome.outcome));
  finish();
  await until(
    () => f.client.command('getChat', { target }),
    (s) => s.run === null && s.entries.some((e) => e.text === 'Final'),
  );
  assert.equal(tools, 1);
  await f.restart();
  assert.equal(
    (await f.client.command('getChatSend', { target, requestId: 'tools' }))?.admission,
    'admitted',
  );
  assert.equal(tools, 1);
  assert.equal(f.faux.state.callCount, 2);
});
test('bounded escaped Unicode history pages retain every durable entry ID without skips', async (t) => {
  const f = await fixture(t, undefined, { tokenSize: { min: 65536, max: 65536 } }),
    target = await f.create(),
    text = '😀\\"\n\u0001\u0000'.repeat(2000);
  f.faux.setResponses(Array.from({ length: 40 }, () => fauxAssistantMessage(text)));
  for (let i = 0; i < 40; i++) {
    await f.client.command('sendChat', {
      target,
      requestId: 'message-' + i,
      text: 'Question ' + i,
    });
    await until(
      () => f.client.command('getChat', { target }),
      (s) => !s.run && s.state === 'idle',
    );
  }
  let page = await f.client.command('getChat', { target });
  const seen = new Set<string>();
  let count = 0;
  while (true) {
    assert(page.entries.length <= 32);
    assert(Buffer.byteLength(JSON.stringify(page)) <= 256 * 1024);
    for (const entry of page.entries) {
      assert(!seen.has(entry.id));
      seen.add(entry.id);
      assert(entry.text.isWellFormed());
      assert(Buffer.byteLength(entry.text) <= 4096);
      if (entry.role === 'assistant') {
        assert(entry.truncated);
        count++;
      }
    }
    if (!page.olderCursor) break;
    const older = await f.client.command('getChatHistory', { target, cursor: page.olderCursor });
    page = { ...page, ...older };
  }
  assert.equal(count, 40);
  for (const bad of ['\ud800', '\0', 'x'.repeat(32769)])
    await assert.rejects(
      f.client.command('sendChat', { target, requestId: 'invalid', text: bad }),
      { code: 'InvalidInput' },
    );
  const other = await f.create('other');
  const initial = await f.client.command('getChat', { target });
  assert(initial.olderCursor);
  await assert.rejects(
    f.client.command('getChatHistory', { target: other, cursor: initial.olderCursor }),
    { code: 'InvalidInput' },
  );
});
test('real SQLite full failure is visible and old committed chats survive reopen', async (t) => {
  const original = NodeSqliteDatabase.prototype.transaction;
  let database: NodeSqliteDatabase | undefined;
  mock.method(NodeSqliteDatabase.prototype, 'transaction', function <
    T,
  >(this: NodeSqliteDatabase, callback: Parameters<typeof original>[0]) {
    // oxlint-disable-next-line no-this-alias -- Capture the actual database used by this intercepted native transaction.
    database = this;
    return original.call(this, callback) as Promise<T>;
  });
  const f = await fixture(t),
    target = await f.create();
  mock.restoreAll();
  const pages = await database!.get<{ page_count: number }>('PRAGMA page_count');
  await database!.exec('PRAGMA max_page_count=' + pages!.page_count);
  await assert.rejects(
    f.client.command('sendChat', { target, requestId: 'full', text: 'x'.repeat(32768) }),
    (e) =>
      !!e &&
      typeof e === 'object' &&
      'code' in e &&
      ['Persistence', 'Uncertain'].includes(String(e.code)),
  );
  await assert.rejects(f.client.command('getChatHost', { host: session.host }), {
    code: 'Persistence',
  });
  assert.equal(f.faux.state.callCount, 0);
  await f.restart();
  assert.deepEqual(
    (await f.client.command('listChats', { session })).conversations[0].target,
    target,
  );
  assert.equal(await f.client.command('getChatSend', { target, requestId: 'full' }), null);
});

test('ten actual tools retain only eight live previews and view disposal never stops them', async (t) => {
  let calls = 0,
    release!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    registry = createRegistry();
  registry.install(
    defineExtension({
      name: 'many',
      tools: [
        defineTool({
          name: 'many',
          description: 'Bounded live fixture',
          parameters: Type.Object({}),
          execute: async (_, api, ctx) => {
            calls++;
            api.output('\\"\u0001😀'.repeat(5000));
            await api.details({ held: true }, ctx);
            await Promise.race([
              gate,
              new Promise<void>((resolve) => {
                if (ctx.abortSignal?.aborted) return resolve();
                ctx.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
              }),
            ]);
            return { output: [{ type: 'text', text: 'Done' }] };
          },
        }),
      ],
    }),
  );
  const f = await fixture(t, registry, { tokenSize: { min: 65536, max: 65536 } }),
    target = await f.create();
  try {
    f.faux.setResponses([
      fauxAssistantMessage(
        Array.from({ length: 10 }, (_, i) => fauxToolCall('many', {}, { id: 'tool-' + i })),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('All complete'),
    ]);
    const snapshots: ChatSnapshot[] = [],
      off = f.client.watch(
        { target },
        (s) => snapshots.push(s),
        (e) => {
          throw e;
        },
      );
    await f.client.command('sendChat', { target, requestId: 'many', text: 'Ten tools' });
    await until(
      () => Promise.resolve(calls),
      (n) => n === 10,
    );
    const view = await until(
      () => f.client.command('getChat', { target }),
      (s) => s.run?.tools.length === 8 && s.run.tools.every((t) => t.text.length > 0),
    );
    assert.equal(view.run!.tools.length, 8);
    assert(Buffer.byteLength(JSON.stringify(view)) <= 256 * 1024);
    await off();
    const before = snapshots.length;
    release();
    await until(
      () => f.client.command('getChat', { target }),
      (s) => !s.run && s.entries.some((e) => e.text === 'All complete'),
    );
    assert.equal(snapshots.length, before);
    assert.equal(calls, 10);
  } finally {
    release();
  }
});
test('null-task Stop never falls through to active work; captured task Stop cooperatively joins it', async (t) => {
  let entered = 0;
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: 'cooperative',
      tools: [
        defineTool({
          name: 'wait',
          description: 'Wait for explicit cancellation',
          parameters: Type.Object({}),
          execute: async (_, api, ctx) => {
            entered++;
            api.output('Waiting');
            await api.details({ waiting: true }, ctx);
            await new Promise<void>((resolve) => {
              if (ctx.abortSignal?.aborted) return resolve();
              ctx.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
            });
            return { output: [{ type: 'text', text: 'Joined' }] };
          },
        }),
      ],
    }),
  );
  const f = await fixture(t, registry),
    target = await f.create();
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall('wait', {}), { stopReason: 'toolUse' })]);
  await f.client.command('sendChat', { target, requestId: 'active', text: 'Wait' });
  const active = await until(
    () => f.client.command('getChat', { target }),
    (s) => entered === 1 && !!s.run?.tools.length,
  );
  const stop = active.run!.stop;
  assert.equal(
    (
      await f.client.command('stopChat', {
        stop: { ...stop, taskId: null },
        requestId: 'queued-only',
      })
    ).outcome,
    'superseded',
  );
  assert.equal((await f.client.command('getChat', { target })).run?.stop.taskId, stop.taskId);
  const result = await f.client.command('stopChat', { stop, requestId: 'task' });
  assert.equal(result.outcome, 'stopped');
  const terminal = await until(
    () => f.client.command('getChat', { target }),
    (s) => !s.run,
  );
  assert.equal(terminal.state, 'stopped');
  assert.equal(entered, 1);
});
test('watch limits, pending unsubscribe/root disposal and arbitrary failing release stay observable without leaking storage', async (t) => {
  const f = await fixture(t),
    target = await f.create();
  await f.restart();
  const original = Harness.open;
  let acquired!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => (acquired = r)),
    gate = new Promise<void>((r) => (release = r));
  let subscriptions = 0;
  mock.method(Harness, 'open', async (...args: Parameters<typeof original>) => {
    const harness = await original(...args);
    acquired();
    await gate;
    const subscribe = harness.subscribeCommits.bind(harness);
    harness.subscribeCommits = (...args) => {
      const off = subscribe(...args);
      subscriptions++;
      return () => {
        subscriptions--;
        off();
      };
    };
    return harness;
  });
  try {
    const errors: unknown[] = [],
      off = f.client.watch(
        { target },
        () => {},
        (e) => errors.push(e),
      );
    await entered;
    const observationClosed = off();
    const closing = f.dispose();
    release();
    await Promise.all([observationClosed, closing]);
    assert.equal(subscriptions, 0);
    assert.equal(errors.length, 0);
  } finally {
    release();
    mock.restoreAll();
  }
  await f.restart();
  const events: ChatSnapshot[] = [],
    errors: unknown[] = [],
    stops = Array.from({ length: 65 }, () =>
      f.client.watch(
        { target },
        (s) => events.push(s),
        (e) => errors.push(e),
      ),
    );
  await until(
    () => Promise.resolve(errors.length),
    (n) => n === 1,
  );
  assert.equal((errors[0] as { code: string }).code, 'Unavailable');
  const closed = await Promise.allSettled(stops.map((off) => off()));
  assert.equal(closed.filter((result) => result.status === 'rejected').length, 1);
  await f.restart();
  const canary = 'private-throwing-unsubscribe-canary';
  mock.method(Harness, 'open', async (...args: Parameters<typeof original>) => {
    const harness = await original(...args),
      subscribe = harness.subscribeCommits.bind(harness);
    harness.subscribeCommits = (...args) => {
      const off = subscribe(...args);
      return () => {
        off();
        throw new Proxy(
          {},
          {
            get() {
              throw canary;
            },
          },
        );
      };
    };
    return harness;
  });
  await f.restart();
  let observed = false;
  const failures: unknown[] = [],
    off = f.client.watch(
      { target },
      () => (observed = true),
      (e) => failures.push(e),
    );
  await until(() => Promise.resolve(observed), Boolean);
  await assert.rejects(off(), (error: unknown) => {
    assert(ApplicationError.is(error));
    assert(!error.message.includes(canary));
    return true;
  });
  assert.equal(failures.length, 0);
  mock.restoreAll();
});

test('model failure remains failed across restart and never exposes raw provider diagnostics', async (t) => {
  const f = await fixture(t),
    target = await f.create(),
    secret = 'private-provider-diagnostic-canary';
  f.faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: secret })]);
  await f.client.command('sendChat', { target, requestId: 'failure', text: 'Fail safely' });
  const failed = await until(
    () => f.client.command('getChat', { target }),
    (s) => !s.run && s.state === 'failed',
  );
  assert(!JSON.stringify(failed).includes(secret));
  await f.restart();
  const recovered = await f.client.command('getChat', { target });
  assert.equal(recovered.state, 'failed');
  assert(!JSON.stringify(recovered).includes(secret));
  assert.equal(f.faux.state.callCount, 1);
});
test('fixed store authority rejects model/cwd/actor/host retargeting without executing work', async (t) => {
  const f = await fixture(t);
  await f.create();
  await f.dispose();
  const alternate = fauxProvider({ provider: 'alternate', models: [{ id: 'alternate' }] });
  f.config.models.setProvider(alternate.provider);
  for (const change of [
    { model: { provider: 'alternate', modelId: 'alternate' } },
    { actorId: 'other' },
    { host: { ...session.host, storeId: 'other' } },
    { cwd: tmpdir() },
  ]) {
    const runtime = ManagedRuntime.make(PiRuntimeLive({ ...f.config, ...change }));
    try {
      await assert.rejects(
        makeChatClient(runtime).command('getChatHost', { host: change.host ?? session.host }),
        { code: 'Incompatible' },
      );
    } finally {
      await runtime.dispose();
    }
  }
  await f.restart();
  assert.equal((await f.client.command('listChats', { session })).conversations.length, 1);
  assert.equal(f.faux.state.callCount, 0);
});

test('completed failing tool activity is projected as failed while another tool remains live', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    registry = createRegistry();
  registry.install(
    defineExtension({
      name: 'tool-status',
      tools: [
        defineTool({
          name: 'fails',
          description: 'Controlled error result',
          parameters: Type.Object({}),
          execute: async () => ({
            isError: true,
            output: [{ type: 'text', text: 'Controlled tool failure' }],
          }),
        }),
        defineTool({
          name: 'holds',
          description: 'Hold the round open',
          parameters: Type.Object({}),
          execute: async (_, api, ctx) => {
            api.output('Holding');
            await api.details({ held: true }, ctx);
            await Promise.race([
              gate,
              new Promise<void>((resolve) => {
                if (ctx.abortSignal?.aborted) return resolve();
                ctx.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
              }),
            ]);
            return { output: [{ type: 'text', text: 'Released' }] };
          },
        }),
      ],
    }),
  );
  const f = await fixture(t, registry, { tokenSize: { min: 65536, max: 65536 } }),
    target = await f.create();
  try {
    f.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('fails', {}), fauxToolCall('holds', {})], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Finished'),
    ]);
    await f.client.command('sendChat', { target, requestId: 'status', text: 'Show tool states' });
    const view = await until(
      () => f.client.command('getChat', { target }),
      (s) => !!s.run?.tools.some((t) => t.name === 'fails' && t.state !== 'running'),
    );
    assert.equal(view.run!.tools.find((t) => t.name === 'fails')!.state, 'failed');
  } finally {
    release();
  }
});

test('selected Pi coding-tool runtime executes in the fixed cwd once and retained Send does not rerun native work after reopen', async (t) => {
  const registry = createRegistry();
  registry.install(CodingTools);
  const f = await fixture(t, registry, { tokenSize: { min: 65536, max: 65536 } }),
    target = await f.create();
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall('bash', { command: 'printf x >> counted.txt; printf "%s" "$$" > native.pid' }),
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Native complete'),
  ]);
  const input = { target, requestId: 'native', text: 'One controlled native effect' };
  const receipt = await f.client.command('sendChat', input);
  await until(
    () => f.client.command('getChat', { target }),
    (s) => !s.run && s.entries.some((e) => e.text === 'Native complete'),
  );
  assert.equal(await readFile(join(f.config.cwd, 'counted.txt'), 'utf8'), 'x');
  const pid = Number(await readFile(join(f.config.cwd, 'native.pid'), 'utf8'));
  assert.throws(
    () => process.kill(pid, 0),
    (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === 'ESRCH',
  );
  await f.restart();
  assert.deepEqual(await f.client.command('sendChat', input), receipt);
  assert.equal(await readFile(join(f.config.cwd, 'counted.txt'), 'utf8'), 'x');
  assert.equal(f.faux.state.callCount, 2);
});

test('null-task Stop withdraws an actual Pi-queued submission while preserving the unrelated active input', async (t) => {
  const original = Harness.open;
  let harness: Harness | undefined;
  mock.method(
    Harness,
    'open',
    async (...args: Parameters<typeof original>) => (harness = await original(...args)),
  );
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    f = await fixture(t),
    target = await f.create();
  try {
    f.faux.setResponses([
      async () => {
        await gate;
        return fauxAssistantMessage('Active input completed');
      },
    ]);
    await f.client.command('sendChat', {
      target,
      requestId: 'active',
      text: 'Preserve this active work',
    });
    const active = await until(
        () => f.client.command('getChat', { target }),
        (s) => !!s.run,
      ),
      stop = active.run!.stop;
    // Public Pi admission creates the queued condition; production Moonbase Send always uses whenBusy:reject.
    const conversation = await harness!.conversation(
      Number(target.conversationId) as ConversationId,
      BACKGROUND_CONTEXT,
    );
    const queued = await conversation!.submit(
      {
        type: 'input',
        content: 'Withdraw only this queued input',
        requestId: 'controlled-pi-queued',
        whenBusy: 'followUp',
      },
      BACKGROUND_CONTEXT,
    );
    assert.equal((await queued.status(BACKGROUND_CONTEXT)).status, 'queued');
    const withdrawn = await f.client.command('stopChat', {
      stop: { target, submissionId: String(queued.id), taskId: null },
      requestId: 'queued-stop',
    });
    assert.equal(withdrawn.outcome, 'stopped');
    assert.equal((await f.client.command('getChat', { target })).run!.stop.taskId, stop.taskId);
    release();
    const final = await until(
      () => f.client.command('getChat', { target }),
      (s) => !s.run && s.entries.some((e) => e.text === 'Active input completed'),
    );
    assert(!final.entries.some((e) => e.text.includes('Withdraw only')));
    assert.equal(f.faux.state.callCount, 1);
  } finally {
    release();
    mock.restoreAll();
  }
});

for (const typed of [false, true])
  test(`R1 create reply-read failure after real commit is uncertain (${typed ? 'typed' : 'unknown'}) and exact retry survives restart`, async (t) => {
    const original = Harness.open;
    let harness: Harness | undefined;
    mock.method(
      Harness,
      'open',
      async (...args: Parameters<typeof original>) => (harness = await original(...args)),
    );
    const f = await fixture(t);
    await f.client.command('getChatHost', { host: session.host });
    mock.restoreAll();
    const committed: string[] = [];
    const off = harness!.subscribeCommits((publication) => {
      for (const change of publication.changes)
        if (change.type === 'conversation') committed.push(String(change.value.id));
    });
    const snapshot = harness!.snapshot.bind(harness!);
    let reads = 0;
    mock.method(harness!, 'snapshot', async (...args: Parameters<typeof snapshot>) => {
      if (reads++ === 0)
        throw typed
          ? new ApplicationError({
              code: 'Persistence',
              message: 'Controlled post-commit read failure',
            })
          : Error('Controlled post-commit read failure');
      return snapshot(...args);
    });
    const input = { session, requestId: 'committed-create', title: 'Original saved chat' };
    let failure: unknown;
    try {
      await f.client.command('createChat', input).catch((error) => {
        failure = error;
      });
    } finally {
      mock.restoreAll();
      await off();
    }
    assert.equal(committed.length, 1);
    assert.equal((await f.client.command('listChats', { session })).conversations.length, 1);
    await f.restart();
    const recovered = await f.client.command('createChat', input);
    assert.equal(recovered.conversation.target.conversationId, committed[0]);
    assert.deepEqual(await f.client.command('createChat', input), recovered);
    await assert.rejects(f.client.command('createChat', { ...input, title: 'Changed' }), {
      code: 'InvalidInput',
    });
    assert.equal((await f.client.command('listChats', { session })).conversations.length, 1);
    assert.equal(f.faux.state.callCount, 0);
    assert.equal(
      (failure as { code?: string })?.code,
      'Uncertain',
      'a real committed conversation appeared definitively rejected',
    );
  });

test('R1 lost typed commit acknowledgement stays uncertain while proven create validation stays definite', async (t) => {
  const original = Harness.open;
  let harness: Harness | undefined;
  mock.method(
    Harness,
    'open',
    async (...args: Parameters<typeof original>) => (harness = await original(...args)),
  );
  const f = await fixture(t);
  await f.client.command('getChatHost', { host: session.host });
  mock.restoreAll();
  const committed: string[] = [];
  const off = harness!.subscribeCommits((publication) => {
    for (const change of publication.changes)
      if (change.type === 'conversation') committed.push(String(change.value.id));
  });
  const commit = harness!.commit.bind(harness!);
  let calls = 0;
  mock.method(harness!, 'commit', async (...args: Parameters<typeof commit>) => {
    calls++;
    await commit(...args);
    throw new ApplicationError({
      code: 'Persistence',
      message: 'Controlled lost commit acknowledgement',
    });
  });
  const input = { session, requestId: 'lost-commit', title: 'Committed' };
  try {
    await assert.rejects(f.client.command('createChat', { ...input, title: '' }), {
      code: 'InvalidInput',
    });
    await assert.rejects(
      f.client.command('createChat', { ...input, session: { ...session, actorId: 'other' } }),
      { code: 'Unauthorized' },
    );
    assert.equal(calls, 0);
    await assert.rejects(f.client.command('createChat', input), { code: 'Uncertain' });
  } finally {
    mock.restoreAll();
    await off();
  }
  assert.equal(committed.length, 1);
  await f.restart();
  const recovered = await f.client.command('createChat', input);
  assert.equal(recovered.conversation.target.conversationId, committed[0]);
  await assert.rejects(f.client.command('createChat', { ...input, title: 'Changed' }), {
    code: 'InvalidInput',
  });
  assert.equal((await f.client.command('listChats', { session })).conversations.length, 1);
  assert.equal(f.faux.state.callCount, 0);
});

test('queued admission cancellation releases its lease without overtaking held SDK work or blocking other conversations and Stop', async (t) => {
  const original = Harness.open;
  let entered!: () => void, release!: () => void;
  const held = new Promise<void>((resolve) => (entered = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  const submissions: string[] = [];
  mock.method(Harness, 'open', async (...args: Parameters<typeof original>) => {
    const harness = await original(...args),
      get = harness.conversation.bind(harness);
    harness.conversation = async (...args: Parameters<typeof get>) => {
      const conversation = await get(...args);
      if (conversation) {
        const submit = conversation.submit.bind(conversation);
        conversation.submit = async (...args: Parameters<typeof submit>) => {
          const requestId = args[0].requestId!;
          submissions.push(requestId);
          if (requestId.includes('held-admission')) {
            entered();
            await gate;
          }
          return submit(...args);
        };
      }
      return conversation;
    };
    return harness;
  });
  t.after(() => {
    release();
    mock.restoreAll();
  });
  const f = await fixture(t),
    target = await f.create(),
    other = await f.create('other-create');
  const input = { target, requestId: 'held-admission', text: 'Original' },
    abort = new AbortController(),
    first = f.client.command('sendChat', input, { signal: abort.signal });
  await held;
  const queuedAbort = new AbortController(),
    queued = f.client.command(
      'sendChat',
      {
        target,
        requestId: 'cancelled-gate',
        text: 'Never submit',
      },
      { signal: queuedAbort.signal },
    );
  await delay(10);
  queuedAbort.abort();
  await assert.rejects(queued, { code: 'Cancelled' });
  abort.abort();
  await assert.rejects(first, { code: 'Cancelled' });
  const successor = f.client.command('sendChat', input);
  f.faux.setResponses([
    async (_messages, options) => {
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) return resolve();
        options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return fauxAssistantMessage('Stopped separately');
    },
    fauxAssistantMessage('Original completed'),
  ]);
  await f.client.command('sendChat', {
    target: other,
    requestId: 'unrelated',
    text: 'Independent',
  });
  const current = await until(
    () => f.client.command('getChat', { target: other }),
    (value) => !!value.run,
  );
  assert.equal(
    (await f.client.command('stopChat', { stop: current.run!.stop, requestId: 'independent-stop' }))
      .outcome,
    'stopped',
  );
  assert.equal(
    await f.client.command('getChatSend', { target, requestId: 'cancelled-gate' }),
    null,
  );
  assert.equal(submissions.filter((id) => id.includes('held-admission')).length, 1);
  release();
  const receipt = await successor;
  assert.equal(receipt.admission, 'admitted');
  assert.deepEqual(
    await f.client.command('getChatSend', { target, requestId: input.requestId }),
    receipt,
  );
  await until(
    () => f.client.command('getChat', { target }),
    (value) => !value.run && value.entries.some((entry) => entry.text === 'Original completed'),
  );
  assert.equal(submissions.filter((id) => id.includes('held-admission')).length, 1);
  assert.equal(f.faux.state.callCount, 2);
});

for (const failure of [false, true])
  test(`Stop deadline covers a held abort join and retains its ${failure ? 'late failure' : 'exact request'} at the root`, async (t) => {
    const original = Harness.open;
    let entered!: () => void, release!: () => void;
    const held = new Promise<void>((resolve) => (entered = resolve)),
      gate = new Promise<void>((resolve) => (release = resolve));
    const canary = 'private-abort-diagnostic-canary';
    let calls = 0;
    mock.method(Harness, 'open', async (...args: Parameters<typeof original>) => {
      const harness = await original(...args),
        abort = harness.abortTask.bind(harness);
      harness.abortTask = async (...args: Parameters<typeof abort>) => {
        calls++;
        entered();
        await gate;
        if (failure)
          throw new Proxy(
            {},
            {
              getPrototypeOf() {
                throw canary;
              },
            },
          );
        return abort(...args);
      };
      return harness;
    });
    const cleanup: (() => Promise<void>)[] = [];
    const f = await fixture({ after: (fn) => cleanup.push(fn) }),
      target = await f.create();
    t.after(async () => {
      release();
      mock.restoreAll();
      for (const close of cleanup) {
        await close();
      }
    });
    f.faux.setResponses([
      async (_messages, options) => {
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) return resolve();
          options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return fauxAssistantMessage('Exact abort completed');
      },
    ]);
    await f.client.command('sendChat', { target, requestId: 'active', text: 'Wait' });
    const current = await until(
      () => f.client.command('getChat', { target }),
      (value) => !!value.run,
    );
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const stop = f.client.command('stopChat', {
      stop: current.run!.stop,
      requestId: 'bounded-stop',
    });
    await held;
    await Promise.resolve();
    t.mock.timers.tick(1001);
    assert.equal((await stop).outcome, 'pending');
    t.mock.timers.reset();
    assert.equal(calls, 1);
    release();
    if (failure) {
      await assert.rejects(f.dispose(), (error: unknown) => {
        assert(!String(error).includes(canary));
        assert(String(error).includes('Pi storage or execution is unavailable'));
        return true;
      });
    } else {
      await until(
        () => f.client.command('getChat', { target }),
        (value) => !value.run,
      );
      f.faux.setResponses([fauxAssistantMessage('Successor survives')]);
      await f.client.command('sendChat', { target, requestId: 'successor', text: 'Next' });
      const old = await f.client.command('stopChat', {
        stop: current.run!.stop,
        requestId: 'bounded-stop',
      });
      assert.ok(['terminal', 'superseded'].includes(old.outcome));
      await until(
        () => f.client.command('getChat', { target }),
        (value) => !value.run && value.entries.some((entry) => entry.text === 'Successor survives'),
      );
      assert.equal(calls, 1);
    }
  });

test('root shutdown drains held admission before closing Harness and reopens its original receipt', async (t) => {
  const original = Harness.open;
  let entered!: () => void, release!: () => void;
  const held = new Promise<void>((resolve) => (entered = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  const order: string[] = [];
  mock.method(Harness, 'open', async (...args: Parameters<typeof original>) => {
    const harness = await original(...args),
      get = harness.conversation.bind(harness),
      close = harness.close.bind(harness);
    harness.conversation = async (...args: Parameters<typeof get>) => {
      const conversation = await get(...args);
      if (conversation) {
        const submit = conversation.submit.bind(conversation);
        conversation.submit = async (...args: Parameters<typeof submit>) => {
          entered();
          await gate;
          const result = await submit(...args);
          order.push('admitted');
          return result;
        };
      }
      return conversation;
    };
    harness.close = async (...args: Parameters<typeof close>) => {
      order.push('harness-close');
      await close(...args);
      order.push('closed');
    };
    return harness;
  });
  t.after(() => {
    release();
    mock.restoreAll();
  });
  const f = await fixture(t),
    target = await f.create();
  f.faux.setResponses([
    async (_messages, options) => {
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) return resolve();
        options?.signal?.addEventListener(
          'abort',
          () => {
            order.push('model-abort');
            resolve();
          },
          { once: true },
        );
      });
      return fauxAssistantMessage('Shutdown interruption');
    },
  ]);
  const send = f.client
    .command('sendChat', { target, requestId: 'shutdown-admission', text: 'Hold admission' })
    .catch((error: unknown) => error);
  await held;
  const closing = f.dispose();
  await delay(10);
  assert.equal(order.length, 0);
  release();
  await Promise.allSettled([send, closing]);
  await closing;
  assert(order.indexOf('admitted') < order.indexOf('harness-close'));
  assert(order.includes('closed'));
  mock.restoreAll();
  await f.restart();
  assert.equal(
    (await f.client.command('getChatSend', { target, requestId: 'shutdown-admission' }))?.admission,
    'admitted',
  );
});

for (const failure of [false, true])
  test(`Stop timeout joins its independently cancelled terminal waiter${failure ? ' and retains a late waiter failure' : ''}`, async (t) => {
    const canary = 'private-terminal-wait-canary';
    const original = Harness.open;
    let entered!: () => void,
      release!: () => void,
      waiters = 0,
      cancelled = 0;
    const waiting = new Promise<void>((resolve) => (entered = resolve)),
      gate = new Promise<void>((resolve) => (release = resolve));
    mock.method(Harness, 'open', async (...args: Parameters<typeof original>) => {
      const harness = await original(...args),
        wait = harness.waitForTask.bind(harness);
      harness.abortTask = async () => 'marked';
      harness.waitForTask = async <R>(id: TaskId<R>, context: Parameters<typeof wait>[1]) => {
        waiters++;
        entered();
        context.abortSignal?.addEventListener(
          'abort',
          () => {
            cancelled++;
          },
          { once: true },
        );
        try {
          return await wait(id, context);
        } catch (error) {
          if (failure) throw Error(canary);
          throw error;
        } finally {
          waiters--;
        }
      };
      return harness;
    });
    t.after(() => {
      release();
      mock.restoreAll();
    });
    const f = await fixture(t),
      target = await f.create();
    f.faux.setResponses([
      async () => {
        await gate;
        return fauxAssistantMessage('Waiter did not stop execution');
      },
    ]);
    await f.client.command('sendChat', { target, requestId: 'active', text: 'Hold model' });
    const current = await until(
      () => f.client.command('getChat', { target }),
      (value) => !!value.run,
    );
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const stop = f.client.command('stopChat', {
      stop: current.run!.stop,
      requestId: 'waiter-stop',
    });
    await waiting;
    t.mock.timers.tick(1001);
    assert.equal((await stop).outcome, 'pending');
    t.mock.timers.reset();
    assert.equal(waiters, 0);
    assert.equal(cancelled, 1);
    assert.deepEqual((await f.client.command('getChat', { target })).run!.stop, current.run!.stop);
    release();
    await until(
      () => f.client.command('getChat', { target }),
      (value) =>
        !value.run && value.entries.some((entry) => entry.text === 'Waiter did not stop execution'),
    );
    if (failure)
      await assert.rejects(f.dispose(), (error: unknown) => {
        assert(!String(error).includes(canary));
        assert(String(error).includes('Pi storage or execution is unavailable'));
        return true;
      });
  });

test('shutdown closes Harness before joining an outstanding abort and releases a held model', async (t) => {
  const original = Harness.open;
  let entered!: () => void, release!: () => void, modelEntered!: () => void;
  const held = new Promise<void>((resolve) => (entered = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve)),
    model = new Promise<void>((resolve) => (modelEntered = resolve));
  const order: string[] = [];
  mock.method(Harness, 'open', async (...args: Parameters<typeof original>) => {
    const harness = await original(...args),
      close = harness.close.bind(harness),
      abort = harness.abortTask.bind(harness);
    harness.abortTask = async (...args: Parameters<typeof abort>) => {
      entered();
      await gate;
      order.push('abort-settled');
      return abort(...args);
    };
    harness.close = async (...args: Parameters<typeof close>) => {
      order.push('harness-close');
      release();
      await close(...args);
      order.push('closed');
    };
    return harness;
  });
  t.after(() => {
    release();
    mock.restoreAll();
  });
  const f = await fixture(t),
    target = await f.create();
  f.faux.setResponses([
    async (_messages, options) => {
      modelEntered();
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener(
          'abort',
          () => {
            order.push('model-abort');
            resolve();
          },
          { once: true },
        ),
      );
      return fauxAssistantMessage('Interrupted on shutdown');
    },
  ]);
  await f.client.command('sendChat', { target, requestId: 'active', text: 'Hold model' });
  await model;
  const current = await until(
    () => f.client.command('getChat', { target }),
    (value) => !!value.run,
  );
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stop = f.client.command('stopChat', {
    stop: current.run!.stop,
    requestId: 'shutdown-stop',
  });
  await held;
  t.mock.timers.tick(1001);
  assert.equal((await stop).outcome, 'pending');
  t.mock.timers.reset();
  await assert.rejects(f.dispose(), (error: unknown) => {
    assert(String(error).includes('Pi storage or execution is unavailable'));
    return true;
  });
  assert(order.indexOf('harness-close') < order.indexOf('abort-settled'));
  assert(order.includes('model-abort'));
  assert(order.includes('closed'));
});

for (const family of ['store', 'metadata', 'request', 'binding'] as const)
  test(`strict ${family} saved payload preserves its exact bytes and refuses admission/reconciliation`, async (t) => {
    const original = Harness.open;
    let harness!: Harness;
    mock.method(
      Harness,
      'open',
      async (...args: Parameters<typeof original>) => (harness = await original(...args)),
    );
    t.after(() => mock.restoreAll());
    const f = await fixture(t),
      target = await f.create();
    f.faux.setResponses([fauxAssistantMessage('Original completed')]);
    await f.client.command('sendChat', { target, requestId: 'saved-send', text: 'Original' });
    await until(
      () => f.client.command('getChat', { target }),
      (value) => !value.run,
    );
    const kind = family === 'binding' ? 'request' : family;
    const initial = () => ({ binding: '', future: null as { nested: boolean } | null });
    const sessionDoc = defineDocFamily({
      kind: 'moonbase.chat.' + kind,
      version: 1,
      scope: 'session',
      family: true,
      initial,
      checkpointWhen: () => true,
    });
    const metadataDoc = defineDocFamily({
      kind: 'moonbase.chat.metadata',
      version: 1,
      scope: 'conversation',
      family: true,
      history: 'latest',
      fork: 'current',
      initial,
      checkpointWhen: () => true,
    });
    let docKey = JSON.stringify([session.actorId, 'saved-send']);
    if (kind === 'store') docKey = 'identity';
    if (kind === 'metadata') docKey = 'metadata';
    // Fixture edits only Moonbase-owned payloads through the public document API.
    const get = () =>
      kind === 'metadata'
        ? harness.snapshot(
            metadataDoc,
            Number(target.conversationId) as ConversationId,
            docKey,
            BACKGROUND_CONTEXT,
          )
        : harness.snapshot(sessionDoc, docKey, BACKGROUND_CONTEXT);
    await harness.commit(async (tx) => {
      const value =
        kind === 'metadata'
          ? await tx.doc(metadataDoc, Number(target.conversationId) as ConversationId, docKey, null)
          : await tx.doc(sessionDoc, docKey, null);
      if (family === 'binding') {
        const bound = JSON.parse(value.binding);
        bound.target.host.future = { nested: true };
        value.binding = JSON.stringify(bound);
      } else value.future = { nested: true };
    }, BACKGROUND_CONTEXT);
    const before = JSON.stringify(await get());
    let commits = 0;
    const off = harness.subscribeCommits(() => {
      commits++;
    });
    try {
      if (kind === 'store')
        await assert.rejects(f.client.command('getChatHost', { host: session.host }), {
          code: 'Persistence',
        });
      else {
        await assert.rejects(
          f.client.command('sendChat', { target, requestId: 'saved-send', text: 'Original' }),
          { code: 'Persistence' },
        );
        await assert.rejects(f.client.command('getChatSend', { target, requestId: 'saved-send' }), {
          code: 'Persistence',
        });
      }
      assert.equal(commits, 0);
      assert.equal(JSON.stringify(await get()), before);
      assert.equal(f.faux.state.callCount, 1);
    } finally {
      off();
    }
    await f.restart();
    if (kind === 'store')
      await assert.rejects(f.client.command('getChatHost', { host: session.host }), {
        code: 'Persistence',
      });
    else
      await assert.rejects(f.client.command('getChatSend', { target, requestId: 'saved-send' }), {
        code: 'Persistence',
      });
    await f.dispose();
    const database = await openNodeSqliteDatabase(f.config.databasePath),
      storage = await SqliteStorage.open(database);
    try {
      const page = await storage.scanDocuments(
        {
          scope:
            kind === 'metadata'
              ? {
                  kind: 'conversation',
                  conversationId: Number(target.conversationId) as ConversationId,
                }
              : { kind: 'session' },
          at: 'current',
          kind: 'moonbase.chat.' + kind,
        },
        32,
        undefined,
        BACKGROUND_CONTEXT,
      );
      const record = page.items.find((record) => record.key === docKey);
      assert(record);
      assert.equal(
        JSON.stringify((await storage.document(record.id, 'current', BACKGROUND_CONTEXT))!.value),
        before,
      );
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
    assert.equal(f.faux.state.callCount, 1);
  });

test('partial acquisition attempts each transferred resource release once and preserves safe composite failures', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moonbase-pi-release-')),
    models = createModels(),
    faux = fauxProvider();
  models.setProvider(faux.provider);
  const root = ManagedRuntime.make(Layer.empty),
    counts = { database: 0, storage: 0, env: 0 },
    canary = 'private-construction-canary';
  const closeDatabase = NodeSqliteDatabase.prototype.close,
    closeStorage = SqliteStorage.prototype.close,
    cleanupEnv = NodeExecutionEnv.prototype.cleanup;
  mock.method(Harness, 'open', async () => {
    throw Error(canary);
  });
  mock.method(NodeSqliteDatabase.prototype, 'close', async function (this: NodeSqliteDatabase) {
    counts.database++;
    return closeDatabase.call(this);
  });
  mock.method(
    SqliteStorage.prototype,
    'close',
    async function (this: SqliteStorage, context: Parameters<typeof closeStorage>[0]) {
      counts.storage++;
      await closeStorage.call(this, context);
      throw new ApplicationError({
        code: 'Persistence',
        message: 'Controlled storage cleanup failure',
      });
    },
  );
  mock.method(
    NodeExecutionEnv.prototype,
    'cleanup',
    async function (this: NodeExecutionEnv, context: Parameters<typeof cleanupEnv>[0]) {
      counts.env++;
      await cleanupEnv.call(this, context);
      throw new ApplicationError({
        code: 'Unavailable',
        message: 'Controlled environment cleanup failure',
      });
    },
  );
  t.after(async () => {
    mock.restoreAll();
    await root.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  await assert.rejects(
    runApplicationEffect(
      root,
      Effect.scoped(
        Layer.build(
          PiRuntimeLive({
            ...session,
            cwd: directory,
            databasePath: join(directory, 'chat.sqlite'),
            models,
            model: { provider: faux.provider.id, modelId: faux.getModel().id },
          }),
        ),
      ),
    ),
    (error: unknown) => {
      assert(ApplicationError.is(error));
      assert.equal(error.code, 'Persistence');
      assert(error.message.includes('Controlled storage cleanup failure'));
      assert(error.message.includes('Controlled environment cleanup failure'));
      assert(!error.message.includes(canary));
      assert(!error.message.includes(directory));
      return true;
    },
  );
  assert.deepEqual(counts, { database: 1, storage: 1, env: 1 });
});

test('unsupported app-owned document version is rejected unchanged before resume or automatic publication', async (t) => {
  const f = await fixture(t);
  await f.create();
  await f.dispose();
  const change = async (write: boolean) => {
    const database = await openNodeSqliteDatabase(f.config.databasePath),
      storage = await SqliteStorage.open(database);
    try {
      const page = await storage.scanDocuments(
        { scope: { kind: 'session' }, kind: 'moonbase.chat.store', at: 'current' },
        1,
        undefined,
        BACKGROUND_CONTEXT,
      );
      const document = await storage.document(page.items[0].id, 'current', BACKGROUND_CONTEXT);
      assert(document);
      if (write)
        await storage.commit(
          [
            {
              type: 'document.change',
              id: document.record.id,
              content: { kind: 'base', version: 2, value: document.value },
            },
          ],
          BACKGROUND_CONTEXT,
        );
      return { value: JSON.stringify(document.value), version: document.version };
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  };
  const original = await change(true);
  await f.restart();
  await assert.rejects(f.client.command('getChatHost', { host: session.host }), {
    code: 'Persistence',
  });
  await f.dispose();
  assert.deepEqual(await change(false), { value: original.value, version: 2 });
  assert.equal(f.faux.state.callCount, 0);
});

test('strict programmatic configuration and cursor envelopes reject nested unfamiliar fields without diagnostics or execution', async (t) => {
  const f = await fixture(t),
    canary = 'private-config-field-canary';
  for (const change of [
    { future: canary },
    { host: { ...session.host, future: canary } },
    { model: { ...f.config.model, future: canary } },
    { cwd: canary },
    { databasePath: '/private/' + 'x'.repeat(4096) },
  ]) {
    const runtime = ManagedRuntime.make(PiRuntimeLive({ ...f.config, ...change }));
    try {
      await assert.rejects(
        makeChatClient(runtime).command('getChatHost', { host: session.host }),
        (error: unknown) => {
          assert(ApplicationError.is(error));
          assert.equal(error.code, 'InvalidInput');
          assert(!error.message.includes(canary));
          assert(!error.message.includes(f.config.cwd));
          return true;
        },
      );
    } finally {
      await runtime.dispose();
    }
  }
  const target = await f.create();
  for (const payload of [
    { kind: 'history', scan: null, future: canary },
    { kind: 'history', scan: { start: true, future: canary } },
    { kind: 'history', scan: [] },
    { kind: 'unknown', scan: null },
  ])
    await assert.rejects(
      f.client.command('getChatHistory', {
        target,
        cursor: Buffer.from(JSON.stringify(payload)).toString('base64url'),
      }),
      { code: 'InvalidInput' },
    );
  assert.equal(f.faux.state.callCount, 0);
});

test('Harness release failure still releases the environment and reports both typed cleanup failures', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moonbase-pi-release-')),
    models = createModels(),
    faux = fauxProvider();
  models.setProvider(faux.provider);
  const root = ManagedRuntime.make(Layer.empty),
    original = Harness.open,
    cleanupEnv = NodeExecutionEnv.prototype.cleanup;
  let closes = 0,
    cleanups = 0;
  mock.method(Harness, 'open', async (...args: Parameters<typeof original>) => {
    const harness = await original(...args),
      close = harness.close.bind(harness);
    harness.close = async (...args: Parameters<typeof close>) => {
      closes++;
      await close(...args);
      throw new ApplicationError({
        code: 'Persistence',
        message: 'Controlled Harness cleanup failure',
      });
    };
    return harness;
  });
  mock.method(
    NodeExecutionEnv.prototype,
    'cleanup',
    async function (this: NodeExecutionEnv, context: Parameters<typeof cleanupEnv>[0]) {
      cleanups++;
      await cleanupEnv.call(this, context);
      throw new ApplicationError({
        code: 'Unavailable',
        message: 'Controlled environment cleanup failure',
      });
    },
  );
  t.after(async () => {
    mock.restoreAll();
    await root.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  await assert.rejects(
    runApplicationEffect(
      root,
      Effect.scoped(
        Layer.build(
          PiRuntimeLive({
            ...session,
            cwd: directory,
            databasePath: join(directory, 'chat.sqlite'),
            models,
            model: { provider: faux.provider.id, modelId: faux.getModel().id },
          }),
        ),
      ),
    ),
    (error: unknown) => {
      assert(ApplicationError.is(error));
      assert(error.message.includes('Controlled Harness cleanup failure'));
      assert(error.message.includes('Controlled environment cleanup failure'));
      return true;
    },
  );
  assert.equal(closes, 1);
  assert.equal(cleanups, 1);
});

test('maximum escaped Send text retains its original serialized binding across retry and restart', async (t) => {
  const f = await fixture(t),
    target = await f.create();
  f.faux.setResponses([fauxAssistantMessage('Escaped input completed')]);
  const input = { target, requestId: 'escaped-binding', text: '\u0001'.repeat(32768) };
  assert(Buffer.byteLength(JSON.stringify({ operation: 'sendChat', ...input })) > 64 * 1024);
  const receipt = await f.client.command('sendChat', input);
  await until(
    () => f.client.command('getChat', { target }),
    (value) =>
      !value.run && value.entries.some((entry) => entry.text === 'Escaped input completed'),
  );
  assert.deepEqual(await f.client.command('sendChat', input), receipt);
  await f.restart();
  assert.deepEqual(
    await f.client.command('getChatSend', { target, requestId: input.requestId }),
    receipt,
  );
  assert.deepEqual(await f.client.command('sendChat', input), receipt);
  assert.equal(f.faux.state.callCount, 1);
});

test('root disposal retains a terminal waiter cleanup failure raised during interruption', async (t) => {
  const original = Harness.open;
  let entered!: () => void,
    waiters = 0,
    cancelled = 0,
    modelAborted = false;
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  mock.method(Harness, 'open', async (...args: Parameters<typeof original>) => {
    const harness = await original(...args),
      wait = harness.waitForTask.bind(harness);
    harness.abortTask = async () => 'marked';
    harness.waitForTask = async <R>(id: TaskId<R>, context: Parameters<typeof wait>[1]) => {
      waiters++;
      entered();
      try {
        return await wait(id, context);
      } catch {
        assert(context.abortSignal?.aborted);
        cancelled++;
        throw new ApplicationError({
          code: 'Persistence',
          message: 'Controlled shutdown waiter cleanup failure',
        });
      } finally {
        waiters--;
      }
    };
    return harness;
  });
  t.after(() => mock.restoreAll());
  const f = await fixture(t),
    target = await f.create();
  f.faux.setResponses([
    async (_messages, options) => {
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) {
          modelAborted = true;
          return resolve();
        }
        options?.signal?.addEventListener(
          'abort',
          () => {
            modelAborted = true;
            resolve();
          },
          { once: true },
        );
      });
      return fauxAssistantMessage('Interrupted by root close');
    },
  ]);
  await f.client.command('sendChat', { target, requestId: 'active', text: 'Held model' });
  const current = await until(
    () => f.client.command('getChat', { target }),
    (value) => !!value.run,
  );
  const stop = f.client
    .command('stopChat', { stop: current.run!.stop, requestId: 'shutdown-waiter' })
    .catch((error: unknown) => error);
  await waiting;
  await assert.rejects(f.dispose(), (error: unknown) => {
    assert(String(error).includes('Controlled shutdown waiter cleanup failure'));
    assert(!String(error).includes(f.config.cwd));
    return true;
  });
  const result = await stop;
  assert(ApplicationError.is(result));
  assert.equal(result.code, 'Cancelled');
  assert.equal(cancelled, 1);
  assert.equal(waiters, 0);
  assert(modelAborted);
});
