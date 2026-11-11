import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import type { ChatSnapshot } from '@moonbase/contracts/chat';
import { session, until, fixture } from './runtime-fixture.ts';

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
      (s) =>
        !!s.run?.transcript?.parts.some(
          (p) => p.kind === 'result' && p.toolName === 'many' && p.text.length > 0,
        ),
    );
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

test('a listing reports each chat activity as its snapshot does, with when it last ran', async (t) => {
  const f = await fixture(t);
  const fresh = await f.create('fresh'),
    finished = await f.create('finished'),
    failed = await f.create('failed'),
    stopped = await f.create('stopped');
  const listed = async () =>
    new Map(
      (await f.client.command('listChats', { session })).conversations.map((chat) => [
        chat.target.conversationId,
        chat,
      ]),
    );
  const before = (await listed()).get(fresh.conversationId)!;
  assert.deepEqual(before.activity, { state: 'idle', at: before.createdAt });

  f.faux.setResponses([fauxAssistantMessage('Done')]);
  await f.client.command('sendChat', { target: finished, requestId: 'send-finished', text: 'Go' });
  await until(
    () => f.client.command('getChat', { target: finished }),
    (s) => !s.run && s.state === 'idle' && s.entries.some((e) => e.text === 'Done'),
  );
  f.faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'x' })]);
  await f.client.command('sendChat', { target: failed, requestId: 'send-failed', text: 'Fail' });
  await until(
    () => f.client.command('getChat', { target: failed }),
    (s) => !s.run && s.state === 'failed',
  );
  f.faux.setResponses([fauxAssistantMessage('a'.repeat(10000))]);
  await f.client.command('sendChat', { target: stopped, requestId: 'send-stopped', text: 'Long' });
  const running = await until(
    () => f.client.command('getChat', { target: stopped }),
    (s) => !!s.run,
  );
  assert.equal((await listed()).get(stopped.conversationId)!.activity!.state, 'running');
  await f.client.command('stopChat', { stop: running.run!.stop, requestId: 'stop' });
  await until(
    () => f.client.command('getChat', { target: stopped }),
    (s) => s.run === null,
  );

  const after = await listed();
  for (const target of [finished, failed, stopped]) {
    const chat = after.get(target.conversationId)!;
    const snapshot = await f.client.command('getChat', { target });
    assert.equal(chat.activity!.state, snapshot.state, target.conversationId);
    assert(Date.parse(chat.activity!.at) >= Date.parse(chat.createdAt));
  }
  assert.equal(after.get(finished.conversationId)!.activity!.state, 'idle');
  assert.equal(after.get(failed.conversationId)!.activity!.state, 'failed');
  assert.notEqual(
    after.get(finished.conversationId)!.activity!.at,
    after.get(finished.conversationId)!.createdAt,
  );
});
