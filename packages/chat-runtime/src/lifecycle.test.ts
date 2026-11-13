import type { TaskId, ConversationId } from '@earendil-works/pi-durable';
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedRuntime } from 'effect';
import { ApplicationError } from '@moonbase/contracts/workspace';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { Harness, createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { NodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { LocalPiRuntimeLive } from './index.ts';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { Effect, Layer } from 'effect';
import { runApplicationEffect } from '@moonbase/application/runtime/effect-client';
import type { ChatSnapshot } from '@moonbase/contracts/chat';
import { session, delay, until, fixture } from '../test/fixtures/runtime-fixture.ts';

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
    (s) => entered === 1 && !!s.run?.transcript?.parts.some((p) => p.role === 'tool'),
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
  // Stop it once its model call holds the first response.
  const current = await until(
    () => f.client.command('getChat', { target: other }),
    (value) => !!value.run && f.faux.state.callCount === 1,
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

test('partial acquisition attempts each transferred resource release once and preserves safe composite failures', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moonbase-pi-release-')),
    models = createModels(),
    faux = fauxProvider();
  models.setProvider(faux.provider);
  const root = ManagedRuntime.make(Layer.empty),
    counts = { database: 0, storage: 0 },
    canary = 'private-construction-canary';
  const closeDatabase = NodeSqliteDatabase.prototype.close,
    closeStorage = SqliteStorage.prototype.close;
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
          LocalPiRuntimeLive({ ...session, databasePath: join(directory, 'chat.sqlite'), models }),
        ),
      ),
    ),
    (error: unknown) => {
      assert(ApplicationError.is(error));
      assert.equal(error.code, 'Persistence');
      assert(error.message.includes('Controlled storage cleanup failure'));
      assert(!error.message.includes(canary));
      assert(!error.message.includes(directory));
      return true;
    },
  );
  assert.deepEqual(counts, { database: 1, storage: 1 });
});

for (const count of [1, 2])
  test(`root disposal retains ${count} terminal waiter cleanup failures raised during interruption`, async (t) => {
    const original = Harness.open;
    let entered!: () => void,
      modelsEntered!: () => void,
      modelEntries = 0,
      waiters = 0,
      cancelled = 0,
      modelAborted = 0;
    const waiting = new Promise<void>((resolve) => (entered = resolve)),
      modelsStarted = new Promise<void>((resolve) => (modelsEntered = resolve)),
      failures: string[] = [];
    mock.method(Harness, 'open', async (...args: Parameters<typeof original>) => {
      const harness = await original(...args),
        wait = harness.waitForTask.bind(harness);
      harness.abortTask = async () => 'marked';
      harness.waitForTask = async <R>(id: TaskId<R>, context: Parameters<typeof wait>[1]) => {
        if (++waiters === count) entered();
        try {
          return await wait(id, context);
        } catch {
          assert(context.abortSignal?.aborted);
          cancelled++;
          const message = 'Controlled shutdown waiter cleanup failure ' + id;
          failures.push(message);
          throw new ApplicationError({ code: 'Persistence', message });
        } finally {
          waiters--;
        }
      };
      return harness;
    });
    t.after(() => mock.restoreAll());
    const f = await fixture(t),
      targets = await Promise.all(
        Array.from({ length: count }, (_, index) => f.create('create-' + index)),
      );
    f.faux.setResponses(
      Array.from({ length: count }, () => async (_messages, options) => {
        if (++modelEntries === count) modelsEntered();
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) {
            modelAborted++;
            return resolve();
          }
          options?.signal?.addEventListener(
            'abort',
            () => {
              modelAborted++;
              resolve();
            },
            { once: true },
          );
        });
        return fauxAssistantMessage('Interrupted by root close');
      }),
    );
    await Promise.all(
      targets.map((target, index) =>
        f.client.command('sendChat', { target, requestId: 'active-' + index, text: 'Held model' }),
      ),
    );
    await modelsStarted;
    const current = await Promise.all(
      targets.map((target) =>
        until(
          () => f.client.command('getChat', { target }),
          (value) => !!value.run,
        ),
      ),
    );
    const stops = current.map((value, index) =>
      f.client
        .command('stopChat', { stop: value.run!.stop, requestId: 'shutdown-waiter-' + index })
        .catch((error: unknown) => error),
    );
    await waiting;
    await assert.rejects(f.disposeObserved(), (error: unknown) => {
      assert(ApplicationError.is(error));
      assert.equal(failures.length, count);
      for (const failure of failures) assert(String(error).includes(failure));
      assert(!String(error).includes(f.config.cwd));
      return true;
    });
    for (const result of await Promise.all(stops)) {
      assert(ApplicationError.is(result));
      assert.equal(result.code, 'Cancelled');
    }
    assert.equal(cancelled, count);
    assert.equal(waiters, 0);
    assert.equal(modelAborted, count);
  });

test('multiple late abort failures remain composed after their Stop responses return pending', async (t) => {
  const original = Harness.open;
  let entered!: () => void,
    release!: () => void,
    aborted = 0;
  const requested = new Promise<void>((resolve) => (entered = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve)),
    failures: string[] = [];
  mock.method(Harness, 'open', async (...args: Parameters<typeof original>) => {
    const harness = await original(...args);
    harness.abortTask = async (id) => {
      if (++aborted === 2) entered();
      await gate;
      const message = 'Controlled late abort failure ' + id;
      failures.push(message);
      throw new ApplicationError({ code: 'Persistence', message });
    };
    return harness;
  });
  t.after(() => {
    release();
    mock.restoreAll();
  });
  const f = await fixture(t),
    targets = await Promise.all([f.create('first'), f.create('second')]);
  f.faux.setResponses(
    Array.from({ length: 2 }, () => async (_messages, options) => {
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) return resolve();
        options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return fauxAssistantMessage('Interrupted by root close');
    }),
  );
  await Promise.all(
    targets.map((target, index) =>
      f.client.command('sendChat', { target, requestId: 'active-' + index, text: 'Held model' }),
    ),
  );
  const current = await Promise.all(
    targets.map((target) =>
      until(
        () => f.client.command('getChat', { target }),
        (value) => !!value.run,
      ),
    ),
  );
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stops = current.map((value, index) =>
    f.client.command('stopChat', { stop: value.run!.stop, requestId: 'late-abort-' + index }),
  );
  await requested;
  t.mock.timers.tick(1001);
  assert((await Promise.all(stops)).every((value) => value.outcome === 'pending'));
  t.mock.timers.reset();
  release();
  await until(
    () => Promise.resolve(failures.length),
    (count) => count === 2,
  );
  await assert.rejects(f.disposeObserved(), (error: unknown) => {
    assert(ApplicationError.is(error));
    for (const failure of failures) assert(error.message.includes(failure), error.message);
    return true;
  });
});
