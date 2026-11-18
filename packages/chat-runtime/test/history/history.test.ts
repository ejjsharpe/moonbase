import assert from 'node:assert/strict';
import { type ErrorGroup, getErrorGroup } from '@moonbase/contracts/error-groups';
import { test } from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { Effect, Fiber, Stream } from 'effect';
import type { ChatSnapshot } from '@moonbase/contracts/chat';
import { ChatService } from '@moonbase/contracts/services';
import { until, fixture, runChat } from '../runtime-fixture.ts';
/** Whether a failure means `group` for its request. */
const inGroup = (group: ErrorGroup) => (error: unknown) => getErrorGroup(error) === group;

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
  await runChat(f.runtime, (chat) =>
    chat.sendChat({ target, requestId: 'tools', text: 'Run counted tool' }),
  );
  const active = await until(
    () => runChat(f.runtime, (chat) => chat.getChat({ target })),
    (s) =>
      !!s.run?.transcript?.parts.some(
        (p) => p.kind === 'result' && p.toolName === 'counted' && p.text.length,
      ),
  );
  const old = active.run!.stop;
  assert.equal(tools, 1);
  assert(
    active.run!.transcript!.parts.every(
      (p) => Buffer.byteLength(p.text) <= 4096 && p.text.isWellFormed(),
    ),
  );
  assert(Buffer.byteLength(JSON.stringify(active)) <= 256 * 1024);
  release();
  await entered;
  const successor = await runChat(f.runtime, (chat) => chat.getChat({ target }));
  assert.notEqual(successor.run!.stop.taskId, old.taskId);
  assert.equal(successor.run!.stop.submissionId, old.submissionId);
  const outcome = await runChat(f.runtime, (chat) =>
    chat.stopChat({ stop: old, requestId: 'old-task' }),
  );
  assert.ok(['terminal', 'superseded'].includes(outcome.outcome));
  finish();
  await until(
    () => runChat(f.runtime, (chat) => chat.getChat({ target })),
    (s) => s.run === null && s.entries.some((e) => e.text === 'Final'),
  );
  assert.equal(tools, 1);
  await f.restart();
  assert.equal(
    (await runChat(f.runtime, (chat) => chat.getChatSend({ target, requestId: 'tools' })))
      ?.admission,
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
    await runChat(f.runtime, (chat) =>
      chat.sendChat({
        target,
        requestId: 'message-' + i,
        text: 'Question ' + i,
      }),
    );
    await until(
      () => runChat(f.runtime, (chat) => chat.getChat({ target })),
      (s) => !s.run && s.state === 'idle',
    );
  }
  let page = await runChat(f.runtime, (chat) => chat.getChat({ target }));
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
    const cursor = page.olderCursor;
    if (!cursor) break;
    const older = await runChat(f.runtime, (chat) => chat.getChatHistory({ target, cursor }));
    page = { ...page, ...older };
  }
  assert.equal(count, 40);
  const other = await f.create('other');
  const initial = await runChat(f.runtime, (chat) => chat.getChat({ target }));
  const cursor = initial.olderCursor;
  assert(cursor);
  await assert.rejects(
    runChat(f.runtime, (chat) => chat.getChatHistory({ target: other, cursor })),
    inGroup('refusal'),
  );
});

test('ten actual tools keep the live snapshot bounded and view disposal never stops them', async (t) => {
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
      watching = f.runtime.runFork(
        Effect.flatMap(ChatService, (chat) =>
          Stream.runForEach(chat.watch({ target }), (s) => Effect.sync(() => snapshots.push(s))),
        ),
      );
    await runChat(f.runtime, (chat) =>
      chat.sendChat({ target, requestId: 'many', text: 'Ten tools' }),
    );
    await until(
      () => Promise.resolve(calls),
      (n) => n === 10,
    );
    const view = await until(
      () => runChat(f.runtime, (chat) => chat.getChat({ target })),
      (s) =>
        !!s.run?.transcript?.parts.some(
          (p) => p.kind === 'result' && p.toolName === 'many' && p.text.length > 0,
        ),
    );
    assert(Buffer.byteLength(JSON.stringify(view)) <= 256 * 1024);
    await Effect.runPromise(Fiber.interrupt(watching));
    const before = snapshots.length;
    release();
    await until(
      () => runChat(f.runtime, (chat) => chat.getChat({ target })),
      (s) => !s.run && s.entries.some((e) => e.text === 'All complete'),
    );
    assert.equal(snapshots.length, before);
    assert.equal(calls, 10);
  } finally {
    release();
  }
});

test('model failure remains failed across restart and never exposes raw provider diagnostics', async (t) => {
  const f = await fixture(t),
    target = await f.create(),
    secret = 'private-provider-diagnostic-canary';
  f.faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: secret })]);
  await runChat(f.runtime, (chat) =>
    chat.sendChat({ target, requestId: 'failure', text: 'Fail safely' }),
  );
  const failed = await until(
    () => runChat(f.runtime, (chat) => chat.getChat({ target })),
    (s) => !s.run && s.state === 'failed',
  );
  assert(!JSON.stringify(failed).includes(secret));
  await f.restart();
  const recovered = await runChat(f.runtime, (chat) => chat.getChat({ target }));
  assert.equal(recovered.state, 'failed');
  assert(!JSON.stringify(recovered).includes(secret));
  assert.equal(f.faux.state.callCount, 1);
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
    await runChat(f.runtime, (chat) =>
      chat.sendChat({ target, requestId: 'status', text: 'Show tool states' }),
    );
    const view = await until(
      () => runChat(f.runtime, (chat) => chat.getChat({ target })),
      (s) =>
        !!s.run?.transcript?.parts.some(
          (p) => p.kind === 'result' && p.toolName === 'fails' && p.state !== 'running',
        ),
    );
    const parts = view.run!.transcript!.parts.filter((p) => p.kind === 'result');
    assert.equal(parts.find((p) => p.toolName === 'fails')!.state, 'failed');
    assert.equal(parts.find((p) => p.toolName === 'holds')!.state, 'running');
  } finally {
    release();
  }
});
