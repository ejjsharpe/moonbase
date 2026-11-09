import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Effect, Fiber, Stream } from 'effect';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import {
  Harness,
  LiveDoc,
  GenerationTask,
  createRegistry,
  defineDocFamily,
  defineExtension,
  defineTool,
  defineTask,
  hook,
  type ConversationId,
  type Tx,
} from '@earendil-works/pi-durable';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { ChatService } from '@moonbase/contracts/services';
import type {
  ChatClient,
  ChatSnapshot,
  ChatTarget,
  ChatHistoryPage,
} from '@moonbase/contracts/chat';
import type { ApplicationError } from '@moonbase/contracts/errors';
import { Type } from 'typebox';
import { fixture, until, delay } from './runtime-fixture.ts';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function observe(t: TestContext, client: ChatClient, target: ChatTarget) {
  const views: ChatSnapshot[] = [],
    errors: ApplicationError[] = [];
  const off = client.watch(
    { target },
    (value) => views.push(value),
    (error) => errors.push(error),
  );
  t.after(async () => {
    await off().catch((error) => {
      assert.equal(error.code, errors[0]?.code);
    });
  });
  return {
    views,
    errors,
    off,
    latest: () => views.at(-1),
    wait: (ready: (s: ChatSnapshot) => boolean) =>
      until(
        async () => {
          if (errors.length) throw errors[0];
          return views.at(-1);
        },
        (value) => !!value && ready(value),
      ).then((value) => value!),
  };
}
function instrument(t: TestContext) {
  let harness!: Harness;
  let watched: ConversationId | undefined;
  const counts = { metadata: 0, scans: 0, entries: 0, inspections: 0, subscriptions: 0 };
  const open = Harness.open;
  t.mock.method(Harness, 'open', async (...args: Parameters<typeof open>) => {
    harness = await open(...args);
    const commit = harness.commit.bind(harness),
      inspect = harness.inspect.bind(harness),
      snapshot = harness.snapshot.bind(harness),
      subscribe = harness.subscribeCommits.bind(harness);
    harness.commit = (change, ctx) =>
      commit(
        (tx) =>
          change(
            new Proxy(tx, {
              get(object, key) {
                if (key === 'scanEntries')
                  return (...values: Parameters<Tx['scanEntries']>) => {
                    counts.scans++;
                    return object.scanEntries(...values);
                  };
                if (key === 'entry')
                  return (...values: Parameters<Tx['entry']>) => {
                    counts.entries++;
                    return object.entry(...values);
                  };
                const value = Reflect.get(object, key);
                return typeof value === 'function' ? value.bind(object) : value;
              },
            }),
          ),
        ctx,
      );
    t.mock.method(harness, 'snapshot', (...values: Parameters<typeof snapshot>) => {
      if (
        values[0].definition.kind === 'moonbase.chat.metadata' &&
        (watched === undefined || Number(values[1]) === watched)
      )
        counts.metadata++;
      return snapshot(...values);
    });
    harness.inspect = (...values) => {
      counts.inspections++;
      return inspect(...values);
    };
    harness.subscribeCommits = (...values) => {
      const off = subscribe(...values);
      counts.subscriptions++;
      return () => {
        counts.subscriptions--;
        off();
      };
    };
    return harness;
  });
  return {
    counts,
    harness: () => harness,
    select: (target: ChatTarget) => {
      watched = conversationId(target);
    },
  };
}
const conversationId = (target: ChatTarget) => Number(target.conversationId) as ConversationId;

test('committed text/thinking stream before completion; B produces no A reads or publications and live-only updates reuse history/status', async (t) => {
  const measured = instrument(t),
    f = await fixture(t, undefined, {}, true),
    target = await f.create(),
    other = await f.create('B');
  measured.select(target);
  const stream = createAssistantMessageEventStream();
  const original = f.faux.provider.streamSimple.bind(f.faux.provider);
  let calls = 0;
  t.mock.method(f.faux.provider, 'streamSimple', (...args: Parameters<typeof original>) => {
    if (++calls !== 1) return original(...args);
    args[2]?.signal?.addEventListener(
      'abort',
      () => stream.end(fauxAssistantMessage('', { stopReason: 'aborted' })),
      { once: true },
    );
    return stream;
  });
  t.after(() => stream.end(fauxAssistantMessage('closed')));
  const watch = observe(t, f.client, target);
  await watch.wait((view) => view.state === 'idle');
  await f.client.command('sendChat', { target, requestId: 'A', text: 'Stream' });
  await watch.wait((view) => !!view.run);
  async function emit(text: string) {
    const partial = fauxAssistantMessage([
      { type: 'thinking', thinking: 'Public thinking ' + text },
      { type: 'text', text },
    ]);
    stream.push({ type: 'text_delta', contentIndex: 1, delta: text, partial });
    return watch.wait((view) => view.run?.text === text);
  }
  const first = await emit('first text');
  assert.equal(first.run!.transcript!.thinking, 'available');
  assert(
    first.run!.transcript!.parts.some(
      (part) => part.kind === 'thinking' && part.text.includes('first text'),
    ),
  );
  const source = first.run!.transcript!.source;
  const before = { ...measured.counts };
  for (let i = 0; i < 4; i++) {
    const view = await emit('more text ' + i);
    assert.deepEqual(view.run!.transcript!.source, source);
    assert.equal(view.transcriptBoundary, first.transcriptBoundary);
  }
  assert.equal(measured.counts.scans, before.scans);
  assert.equal(measured.counts.entries, before.entries);
  assert.equal(measured.counts.inspections, before.inspections);
  const publications = watch.views.length,
    reads = { ...measured.counts };
  f.faux.setResponses([fauxAssistantMessage('B finished')]);
  await f.client.command('sendChat', { target: other, requestId: 'send-B', text: 'Unrelated' });
  await (await measured.harness().conversation(conversationId(other), context))!.waitForIdle(
    context,
  );
  for (let i = 0; i < 64; i++)
    await measured
      .harness()
      .commit(
        (tx) =>
          tx.appendEntry(conversationId(other), { kind: 'app.unrelated', data: { index: i } }),
        context,
      );
  await delay(30);
  assert.equal(watch.views.length, publications);
  assert.equal(measured.counts.metadata, reads.metadata);
  assert.equal(measured.counts.scans, reads.scans);
  assert.equal(measured.counts.entries, reads.entries);
  assert.equal(measured.counts.inspections, reads.inspections);
  const final = fauxAssistantMessage('complete');
  stream.push({ type: 'done', reason: 'stop', message: final });
  stream.end(final);
  const done = await watch.wait(
    (view) => !view.run && view.entries.some((entry) => entry.text === 'complete'),
  );
  assert.notEqual(done.transcriptBoundary, first.transcriptBoundary);
  assert(measured.counts.scans > before.scans);
  assert.deepEqual(watch.errors, []);
  await watch.off();
  assert.equal(measured.counts.subscriptions, 0);
});

test('steady provider progress publishes while projection is slower than the commit interval', async (t) => {
  const measured = instrument(t),
    f = await fixture(t, undefined, {}, true),
    target = await f.create();
  const stream = createAssistantMessageEventStream();
  t.mock.method(
    f.faux.provider,
    'streamSimple',
    (...args: Parameters<typeof f.faux.provider.streamSimple>) => {
      args[2]?.signal?.addEventListener(
        'abort',
        () => stream.end(fauxAssistantMessage('', { stopReason: 'aborted' })),
        { once: true },
      );
      return stream;
    },
  );
  const watch = observe(t, f.client, target);
  await watch.wait((view) => view.state === 'idle');
  await f.client.command('sendChat', { target, requestId: 'steady', text: 'Stream steadily' });
  function emit(text: string) {
    stream.push({
      type: 'text_delta',
      contentIndex: 0,
      delta: text,
      partial: fauxAssistantMessage(text),
    });
  }
  emit('opening');
  const initial = await watch.wait((view) => view.run?.text === 'opening');
  const commit = measured.harness().commit.bind(measured.harness());
  t.mock.method(measured.harness(), 'commit', async (...args: Parameters<typeof commit>) => {
    const result = await commit(...args);
    if (result && typeof result === 'object' && 'live' in result && 'boundary' in result)
      await delay(175);
    return result;
  });
  const before = { ...measured.counts };
  for (let i = 0; i < 25; i++) {
    emit('steady ' + i);
    await delay(110);
  }
  const progress = watch.views.filter((view) => view.run?.text.startsWith('steady '));
  const during = { ...measured.counts };
  const final = fauxAssistantMessage('completed steady stream');
  stream.push({ type: 'done', reason: 'stop', message: final });
  stream.end(final);
  await watch.wait(
    (view) => !view.run && view.entries.some((entry) => entry.text === 'completed steady stream'),
  );
  assert(
    progress.length >= 2,
    `Expected text during continuous progress, received ${progress.length} live updates.`,
  );
  for (const view of progress) {
    assert.deepEqual(view.run!.transcript!.source, initial.run!.transcript!.source);
    assert.equal(view.transcriptBoundary, initial.transcriptBoundary);
  }
  assert.equal(during.scans, before.scans);
  assert.equal(during.entries, before.entries);
  assert.equal(during.inspections, before.inspections);
  assert.deepEqual(watch.errors, []);
});

test('live tool output is observed while execution is held; progress does not inspect the task graph or reload history', async (t) => {
  const measured = instrument(t),
    hold = gate(),
    registry = createRegistry();
  let output!: (text: string) => void;
  registry.install(
    defineExtension({
      name: 'progress',
      tools: [
        defineTool({
          name: 'progress',
          description: 'Controlled progress',
          parameters: Type.Object({}),
          execute: async (_, api, ctx) => {
            output = (text) => api.output(text);
            api.output('first tool output');
            await api.details({ patch: 'retained patch' }, ctx);
            await hold.promise;
            return { output: [{ type: 'text', text: 'tool completed' }] };
          },
        }),
      ],
    }),
  );
  t.after(hold.release);
  const f = await fixture(t, registry),
    target = await f.create(),
    watch = observe(t, f.client, target);
  await watch.wait((view) => view.state === 'idle');
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall('progress', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage('done'),
  ]);
  await f.client.command('sendChat', { target, requestId: 'tool', text: 'Tool' });
  const toolOutput = (view: ChatSnapshot) =>
    view.run?.transcript?.parts.find((part) => part.partId === 'tool0.output')?.text;
  await watch.wait((view) => toolOutput(view) === 'first tool output');
  const before = { ...measured.counts };
  for (let i = 0; i < 3; i++) {
    output(' more ' + i);
    await watch.wait((view) => !!toolOutput(view)?.includes(' more ' + i));
  }
  assert.equal(measured.counts.scans, before.scans);
  assert.equal(measured.counts.inspections, before.inspections);
  hold.release();
  await watch.wait((view) => !view.run && view.entries.some((entry) => entry.text === 'done'));
  assert.deepEqual(watch.errors, []);
});

test('registration precedes initial capture; a held stale snapshot is replaced after completion without mixing sources', async (t) => {
  const measured = instrument(t),
    f = await fixture(t),
    target = await f.create(),
    hold = gate(),
    read = gate();
  t.after(hold.release);
  t.after(read.release);
  f.faux.setResponses([
    async () => {
      await hold.promise;
      return fauxAssistantMessage('final');
    },
  ]);
  await f.client.command('sendChat', { target, requestId: 'held', text: 'Hold' });
  await until(
    () => measured.harness().snapshot(LiveDoc, conversationId(target), context),
    (live) => !!live?.generation,
  );
  await measured.harness().commit(async (tx) => {
    const live = await tx.doc(LiveDoc, conversationId(target));
    live.generation!.message = JSON.parse(JSON.stringify(fauxAssistantMessage('partial')));
  }, context);
  const commit = measured.harness().commit.bind(measured.harness());
  let held = false;
  t.mock.method(measured.harness(), 'commit', async (...args: Parameters<typeof commit>) => {
    const result = await commit(...args);
    if (!held && result && typeof result === 'object' && 'live' in result && 'boundary' in result) {
      assert(measured.counts.subscriptions > 0);
      held = true;
      await read.promise;
    }
    return result;
  });
  const watch = observe(t, f.client, target);
  await until(async () => held, Boolean);
  hold.release();
  await (await measured.harness().conversation(conversationId(target), context))!.waitForIdle(
    context,
  );
  read.release();
  const view = await watch.wait(
    (value) => !value.run && value.entries.some((entry) => entry.text === 'final'),
  );
  assert.equal(watch.views.length, 1);
  assert.equal(view.transcriptBoundary, view.entries[0].id);
  assert.deepEqual(watch.errors, []);
});

for (const change of ['attempt', 'tools', 'history', 'metadata', 'store', 'replacement'] as const)
  test(`a held progress snapshot cannot publish across ${change} invalidation`, async (t) => {
    const hold = gate(),
      read = gate();
    t.after(hold.release);
    t.after(read.release);
    const measured = instrument(t),
      f = await fixture(t),
      target = await f.create();
    f.faux.setResponses([
      async () => {
        await hold.promise;
        return fauxAssistantMessage('final');
      },
    ]);
    await f.client.command('sendChat', { target, requestId: 'held', text: 'Hold' });
    await until(
      () => measured.harness().snapshot(LiveDoc, conversationId(target), context),
      (live) => !!live?.generation,
    );
    await measured.harness().commit(async (tx) => {
      const live = await tx.doc(LiveDoc, conversationId(target));
      live.generation!.message = JSON.parse(
        JSON.stringify(fauxAssistantMessage('captured progress')),
      );
    }, context);
    const initial = await f.client.command('getChat', { target });
    const metadata = defineDocFamily<{ identity: string }, null>({
      kind: 'moonbase.chat.metadata',
      version: 1,
      scope: 'conversation',
      family: true,
      history: 'latest',
      fork: 'current',
      initial: () => ({ identity: '' }),
      checkpointWhen: () => true,
    });
    const store = defineDocFamily<{ identity: string }, null>({
      kind: 'moonbase.chat.store',
      version: 1,
      scope: 'session',
      family: true,
      initial: () => ({ identity: '' }),
      checkpointWhen: () => true,
    });
    const commit = measured.harness().commit.bind(measured.harness());
    let held = false;
    t.mock.method(measured.harness(), 'commit', async (...args: Parameters<typeof commit>) => {
      const result = await commit(...args);
      if (
        !held &&
        result &&
        typeof result === 'object' &&
        'live' in result &&
        'boundary' in result
      ) {
        held = true;
        await read.promise;
      }
      return result;
    });
    const watch = observe(t, f.client, target);
    await until(async () => held, Boolean);
    await commit(async (tx) => {
      if (change === 'metadata') return tx.retireDoc(metadata, conversationId(target), 'metadata');
      if (change === 'store') {
        const owner = await tx.doc(store, 'identity', null);
        const identity = JSON.parse(owner.identity);
        identity.actorId = 'revoked';
        owner.identity = JSON.stringify(identity);
        return;
      }
      if (change === 'history') {
        await tx.appendEntry(conversationId(target), { kind: 'app.boundary', data: {} });
        return;
      }
      if (change === 'replacement') await tx.retireDoc(LiveDoc, conversationId(target));
      const live = await tx.doc(LiveDoc, conversationId(target));
      if (change === 'attempt') live.generation!.attempt++;
      if (change === 'tools')
        live.tools = [{ callId: 'control', name: 'control', status: 'pending' }];
    }, context);
    read.release();
    if (change === 'metadata' || change === 'store') {
      await until(async () => watch.errors.length, Boolean);
      assert.equal(watch.errors[0].code, 'Unauthorized');
      assert.deepEqual(watch.views, []);
      await assert.rejects(watch.off(), { code: 'Unauthorized' });
    } else {
      const next = await watch.wait(() => true);
      assert.equal(watch.views.length, 1);
      if (change === 'replacement') assert.equal(next.run, null);
      else assert.notDeepEqual(next.run!.transcript!.source, initial.run!.transcript!.source);
      if (change === 'history')
        assert.notEqual(next.transcriptBoundary, initial.transcriptBoundary);
      if (change === 'attempt') {
        assert.equal(next.run!.transcript!.source.kind, 'live');
        const previous = initial.run!.transcript!.source;
        assert.equal(previous.kind, 'live');
        if (next.run!.transcript!.source.kind === 'live' && previous.kind === 'live')
          assert.equal(next.run!.transcript!.source.attempt, previous.attempt + 1);
      }
      assert.deepEqual(watch.errors, []);
    }
  });

test('slow consumers coalesce a burst to one bounded replacement; Stop and another conversation remain responsive', async (t) => {
  const measured = instrument(t),
    f = await fixture(t),
    target = await f.create(),
    hold = gate(),
    consumer = gate();
  t.after(hold.release);
  t.after(consumer.release);
  f.faux.setResponses([
    async () => {
      await hold.promise;
      return fauxAssistantMessage('final');
    },
  ]);
  await f.client.command('sendChat', { target, requestId: 'slow', text: 'Hold' });
  await until(
    () => measured.harness().snapshot(LiveDoc, conversationId(target), context),
    (live) => !!live?.generation,
  );
  const commit = measured.harness().commit.bind(measured.harness());
  let captures = 0;
  t.mock.method(measured.harness(), 'commit', async (...args: Parameters<typeof commit>) => {
    const result = await commit(...args);
    if (result && typeof result === 'object' && 'live' in result && 'boundary' in result) {
      captures++;
    }
    return result;
  });
  const views: ChatSnapshot[] = [];
  const fiber = f.runtime.runFork(
    Effect.gen(function* () {
      const service = yield* ChatService;
      yield* Stream.runForEach(service.watch({ target }), (view) =>
        Effect.promise(async () => {
          views.push(view);
          if (views.length === 1) await consumer.promise;
        }),
      );
    }),
  );
  t.after(async () => {
    consumer.release();
    await Effect.runPromise(Fiber.interrupt(fiber));
  });
  await until(async () => views.length, Boolean);
  const before = measured.counts.scans;
  for (let i = 0; i < 220; i++)
    await commit(async (tx) => {
      const live = await tx.doc(LiveDoc, conversationId(target));
      live.generation!.message = JSON.parse(
        JSON.stringify(fauxAssistantMessage('\\"\0😀'.repeat(3000) + i)),
      );
    }, context);
  const other = await f.create('other');
  assert(other.conversationId !== target.conversationId);
  assert.equal(captures, 1);
  assert.equal(views.length, 1);
  consumer.release();
  const view = await until(
    async () => views.at(-1),
    (value) => !!value?.run?.text,
  );
  assert(view);
  assert(view.run!.text.startsWith('\\"\0😀'));
  assert(Buffer.byteLength(JSON.stringify(view)) < 256 * 1024);
  assert.equal(captures, 2);
  assert.equal(measured.counts.scans, before);
  const part = view.run!.transcript!.parts.find((part) => part.kind === 'text')!;
  const content = await f.client.command('getChatTranscriptContent', {
    source: view.run!.transcript!.source,
    selection: { partId: part.partId, bytes: part.bytes, revision: part.revision },
  });
  assert.equal(content.kind, 'content');
  if (content.kind !== 'content') throw Error();
  assert.equal(content.data, '\\"\0😀'.repeat(3000) + '219');
  assert.equal(content.nextCursor, null);
  const stopped = f.client.command('stopChat', { stop: view.run!.stop, requestId: 'stop' });
  assert.ok(['stopped', 'pending', 'terminal'].includes((await stopped).outcome));
  hold.release();
  await f.runtime.runPromise(Fiber.interrupt(fiber));
  assert.equal(measured.counts.subscriptions, 0);
});

test('closing a held observation fences delivery and retains SDK settlement through root disposal', async (t) => {
  const measured = instrument(t),
    f = await fixture(t),
    target = await f.create(),
    read = gate();
  t.after(read.release);
  const commit = measured.harness().commit.bind(measured.harness());
  let held = false;
  t.mock.method(measured.harness(), 'commit', async (...args: Parameters<typeof commit>) => {
    const result = await commit(...args);
    if (!held && result && typeof result === 'object' && 'live' in result && 'boundary' in result) {
      held = true;
      await read.promise;
    }
    return result;
  });
  const watch = observe(t, f.client, target);
  await until(async () => held, Boolean);
  await watch.off();
  assert.equal(measured.counts.subscriptions, 0);
  let disposed = false;
  const closing = f.dispose().then(() => {
    disposed = true;
  });
  await delay(25);
  assert.equal(disposed, false);
  read.release();
  await closing;
  assert.deepEqual(watch.views, []);
  assert.deepEqual(watch.errors, []);
});

test('metadata authority changes fail visibly without publishing foreign state', async (t) => {
  const measured = instrument(t),
    f = await fixture(t),
    target = await f.create();
  const metadata = defineDocFamily<{ identity: string }, null>({
    kind: 'moonbase.chat.metadata',
    version: 1,
    scope: 'conversation',
    history: 'latest',
    fork: 'current',
    family: true,
    initial: () => ({ identity: '' }),
    checkpointWhen: () => true,
  });
  const watch = observe(t, f.client, target);
  await watch.wait((view) => view.state === 'idle');
  await measured.harness().commit(async (tx) => {
    (await tx.doc(metadata, conversationId(target), 'metadata', null)).identity = 'foreign';
  }, context);
  await until(async () => watch.errors.length, Boolean);
  assert.equal(watch.errors[0].code, 'Unauthorized');
  assert.equal(watch.views.length, 1);
  await assert.rejects(watch.off(), { code: 'Unauthorized' });
});

test('retiring LiveDoc reports a source failure, releases subscriptions and never recreates the document', async (t) => {
  const measured = instrument(t),
    f = await fixture(t),
    target = await f.create();
  const watch = observe(t, f.client, target);
  await watch.wait((view) => view.state === 'idle');
  await measured.harness().commit((tx) => tx.retireDoc(LiveDoc, conversationId(target)), context);
  await until(async () => watch.errors.length, Boolean);
  assert.equal(watch.errors[0].code, 'Persistence');
  assert.equal(watch.views.length, 1);
  assert.equal(
    await measured.harness().snapshot(LiveDoc, conversationId(target), context),
    undefined,
  );
  assert.equal(measured.counts.subscriptions, 0);
  await assert.rejects(watch.off(), { code: 'Persistence' });
});

for (const policy of [
  { limit: 1, restarts: 1, parked: true },
  { limit: 8, restarts: 5, parked: false },
])
  test(`Pi inspection honors restartLimit=${policy.limit} at restarts=${policy.restarts}, with explicit retry and terminal transitions`, async (t) => {
    const measured = instrument(t),
      open = Harness.open,
      hold = gate();
    t.after(hold.release);
    let seed = false;
    t.mock.method(Harness, 'open', async (...[storage, options, ctx]: Parameters<typeof open>) => {
      if (seed) {
        const task = (await storage.scanTasks({ kind: 'pi.generation' }, 1, undefined, ctx))
          .items[0];
        assert(task && task.state.status !== 'terminal');
        // Seed the public persisted crash counter in this temporary store, not SDK private state.
        await storage.commit(
          [{ type: 'task', value: { ...task, restarts: policy.restarts } }],
          ctx,
        );
      }
      const settings =
        typeof options.settings === 'function' ? options.settings() : options.settings;
      return open(
        storage,
        { ...options, settings: { ...settings, restartLimit: policy.limit } },
        ctx,
      );
    });
    const f = await fixture(t, undefined, { tokensPerSecond: 1000 }),
      target = await f.create();
    f.faux.setResponses([
      fauxAssistantMessage('partial '.repeat(2000)),
      async () => {
        await hold.promise;
        return fauxAssistantMessage('recovered');
      },
    ]);
    await f.client.command('sendChat', { target, requestId: 'recover', text: 'Recover' });
    const firstWatch = observe(t, f.client, target);
    const first = await firstWatch.wait((view) => !!view.run?.text);
    const old = first.run!.transcript!.source;
    assert.equal(old.kind, 'live');
    if (old.kind !== 'live') throw Error();
    await firstWatch.off();
    seed = true;
    await f.restart();
    const watch = observe(t, f.client, target);
    if (policy.parked) {
      const parked = await watch.wait((view) => view.state === 'failed' && !!view.run);
      assert(parked.message?.includes('parked'));
      assert.equal(f.faux.state.callCount, 1);
      assert.equal((await f.client.command('getChat', { target })).state, 'failed');
      await measured
        .harness()
        .retryTask(Number(old.taskId) as Parameters<Harness['retryTask']>[0], context);
    }
    const next = await watch.wait(
      (view) =>
        view.state === 'running' &&
        view.entries.some((entry) =>
          entry.transcript?.parts.some((part) => part.state === 'interrupted'),
        ),
    );
    const source = next.run!.transcript!.source;
    assert.equal(source.kind, 'live');
    if (source.kind !== 'live') throw Error();
    assert.equal(source.taskId, old.taskId);
    assert.equal(source.attempt, old.attempt);
    assert.notEqual(source.incarnation, old.incarnation);
    assert.notEqual(next.transcriptBoundary, first.transcriptBoundary);
    assert(!next.message?.includes('parked'));
    await assert.rejects(f.client.command('getChatTranscriptContent', { source: old }), {
      code: 'Conflict',
    });
    hold.release();
    await watch.wait(
      (view) =>
        !view.run &&
        view.state === 'idle' &&
        view.entries.some((entry) => entry.text === 'recovered'),
    );
    assert.equal(f.faux.state.callCount, 2);
    assert.deepEqual(watch.errors, []);
  });

test('scheduler-finalized unattributed partial replaces live state coherently and redacts the fault', async (t) => {
  const hold = gate(),
    registry = createRegistry();
  t.after(hold.release);
  let entered = false;
  registry.install(
    defineExtension({
      name: 'fault',
      hooks: [
        hook(GenerationTask, {
          afterResponse: async (message) => {
            entered = true;
            await hold.promise;
            message.usage.input = Number.NaN;
            message.errorMessage = 'private-observation-fault-canary';
          },
        }),
      ],
    }),
  );
  const measured = instrument(t),
    f = await fixture(t, registry, { tokensPerSecond: 4000 }),
    target = await f.create();
  f.faux.setResponses([fauxAssistantMessage('retained partial '.repeat(200))]);
  const watch = observe(t, f.client, target);
  await f.client.command('sendChat', { target, requestId: 'fault', text: 'Fault' });
  const live = await watch.wait((view) => !!view.run?.text);
  await until(async () => entered, Boolean);
  hold.release();
  const done = await watch.wait((view) => !view.run && view.state === 'failed');
  const partial = done.entries.find((entry) =>
    entry.transcript?.parts.some((part) => part.state === 'interrupted'),
  );
  assert(partial);
  const raw = await measured
    .harness()
    .commit((tx) => tx.entry(Number(partial.id) as Parameters<Tx['entry']>[1]), context);
  assert.equal(raw?.byTaskId, undefined);
  assert.notEqual(done.transcriptBoundary, live.transcriptBoundary);
  assert(
    watch.views.every((view) => !view.run || view.transcriptBoundary === live.transcriptBoundary),
  );
  assert(!JSON.stringify(watch.views).includes('private-observation-fault-canary'));
  assert.deepEqual(watch.errors, []);
});

test('missing and failed-migration task definitions update without a commit, then unblock and settle without leaking diagnostics', async (t) => {
  const hold = gate(),
    registry = createRegistry();
  t.after(hold.release);
  const measured = instrument(t),
    f = await fixture(t, registry),
    target = await f.create();
  const task = defineTask<null, { phase: 'run' }, null>({
    name: 'controlled.observation',
    version: 1,
    initial: () => ({ phase: 'run' }),
    phases: {
      run: async (_task, runtime, ctx) => {
        await hold.promise;
        await runtime.commit(async (tx) => {
          const live = await tx.doc(LiveDoc, runtime.conversationId);
          const inputs = [...live.run!.inputs];
          delete live.run;
          delete live.generation;
          const answer = await tx.appendEntry(runtime.conversationId, {
            kind: 'app.completed',
            data: {},
            model: [fauxAssistantMessage('task finished')],
          });
          for (const input of inputs)
            tx.settleSubmission(input, { status: 'done', answer: answer.id });
          return { status: 'terminal', outcome: { status: 'completed', result: null } };
        }, ctx);
      },
    },
    abort: async (_, runtime, ctx) => {
      await runtime.commit(async (tx) => {
        const live = await tx.doc(LiveDoc, runtime.conversationId);
        delete live.run;
        delete live.generation;
        return { status: 'terminal', outcome: { status: 'aborted' } };
      }, ctx);
    },
  });
  const watch = observe(t, f.client, target);
  await watch.wait((view) => view.state === 'idle');
  await measured.harness().commit(async (tx) => {
    const live = await tx.doc(LiveDoc, conversationId(target));
    const entry = await tx.appendEntry(conversationId(target), {
      kind: 'app.input',
      data: {},
      model: [{ role: 'user', content: 'Controlled task', timestamp: Date.now() }],
    });
    const input = await tx.createSubmission({
      type: 'input',
      status: 'placed',
      entry: entry.id,
      conversationId: conversationId(target),
    });
    const taskId = await tx.createTask(task, null, {
      conversationId: conversationId(target),
      ownership: { kind: 'conversation' },
    });
    live.run = { taskId, inputs: [input.id] };
    live.generation = { attempt: 0 };
  }, context);
  const missing = await watch.wait((view) => view.state === 'failed' && !!view.run);
  assert(missing.message?.includes('definitions'));
  const count = watch.views.length;
  registry.install(
    defineExtension({
      name: 'controlled-definition',
      tasks: [
        defineTask({
          ...task.definition,
          version: 2,
          migrate: () => {
            throw Error('private-migration-canary');
          },
        }),
      ],
    }),
  );
  await until(
    async () => (await measured.harness().inspect(context)).tasks,
    (tasks) =>
      tasks.some(
        (item) => item.state.kind === 'blocked' && item.state.reason === 'migration_failed',
      ),
  );
  await until(
    async () => watch.views.length,
    (value) => value > count,
  );
  assert.equal(watch.latest()!.state, 'failed');
  registry.install(
    defineExtension({
      name: 'controlled-definition',
      tasks: [
        defineTask({
          ...task.definition,
          version: 2,
          migrate: () => ({ input: null, checkpoint: { phase: 'run' as const } }),
        }),
      ],
    }),
  );
  await watch.wait((view) => view.state === 'running' && !view.message);
  hold.release();
  await watch.wait(
    (view) =>
      view.state === 'idle' &&
      !view.run &&
      view.entries.some((entry) => entry.text === 'task finished'),
  );
  assert(!JSON.stringify(watch.views).includes('private-migration-canary'));
  assert.equal(f.faux.state.callCount, 0);
  assert.deepEqual(watch.errors, []);
});

test('a growing escaped live preview resizes cached history within the byte budget and keeps exact older cursors', async (t) => {
  const hold = gate();
  t.after(hold.release);
  const measured = instrument(t),
    f = await fixture(t),
    target = await f.create();
  await measured.harness().commit(async (tx) => {
    for (let i = 0; i < 50; i++)
      await tx.appendEntry(conversationId(target), {
        kind: 'app.history',
        data: {},
        model: [fauxAssistantMessage('\0'.repeat(2048))],
      });
  }, context);
  f.faux.setResponses([
    async () => {
      await hold.promise;
      return fauxAssistantMessage('finished');
    },
  ]);
  const watch = observe(t, f.client, target);
  await f.client.command('sendChat', { target, requestId: 'large', text: 'Hold' });
  await until(
    () => measured.harness().snapshot(LiveDoc, conversationId(target), context),
    (live) => !!live?.generation,
  );
  const small = await watch.wait((view) => !!view.run && !view.run.text);
  const before = measured.counts.scans;
  // The escaped preview grows by more than one history entry.
  await measured.harness().commit(async (tx) => {
    const live = await tx.doc(LiveDoc, conversationId(target));
    live.generation!.message = JSON.parse(JSON.stringify(fauxAssistantMessage('\0'.repeat(4096))));
  }, context);
  const large = await watch.wait((view) => !!view.run?.text.includes('\0'));
  assert.equal(measured.counts.scans, before);
  assert(large.entries.length < small.entries.length);
  assert.equal(large.transcriptBoundary, small.transcriptBoundary);
  assert(Buffer.byteLength(JSON.stringify(large)) < 256 * 1024);
  assert(large.olderCursor);
  const ids = new Set(large.entries.map((entry) => entry.id));
  let cursor: string | null = large.olderCursor;
  while (cursor) {
    const page: ChatHistoryPage = await f.client.command('getChatHistory', { target, cursor });
    for (const entry of page.entries) {
      assert(!ids.has(entry.id));
      ids.add(entry.id);
    }
    cursor = page.olderCursor;
  }
  const saved = await measured
    .harness()
    .commit((tx) => tx.scanEntries({ conversationId: conversationId(target) }, 100), context);
  assert.deepEqual(ids, new Set(saved.items.map((entry) => String(entry.id))));
  hold.release();
  await watch.wait((view) => !view.run && view.entries.some((entry) => entry.text === 'finished'));
  assert.deepEqual(watch.errors, []);
});

for (const failure of [false, true])
  test(`SDK session ${failure ? 'failure' : 'close'} ends observation safely and releases listeners`, async (t) => {
    const measured = instrument(t),
      f = await fixture(t),
      target = await f.create();
    const watch = observe(t, f.client, target);
    await watch.wait((view) => view.state === 'idle');
    if (failure) {
      const commit = t.mock.method(SqliteStorage.prototype, 'commit', async () => {
        throw Error('private-storage-canary');
      });
      await assert.rejects(
        measured
          .harness()
          .commit(
            (tx) => tx.appendEntry(conversationId(target), { kind: 'app.fail', data: {} }),
            context,
          ),
      );
      commit.mock.restore();
    } else await measured.harness().close(context);
    await until(async () => watch.errors.length, Boolean);
    assert.equal(watch.errors[0].code, 'Persistence');
    assert(!JSON.stringify(watch.errors).includes('private-storage-canary'));
    assert.equal(watch.views.length, 1);
    assert.equal(measured.counts.subscriptions, 0);
    await assert.rejects(watch.off(), { code: 'Persistence' });
  });

test('a committed reset marker refreshes the selected retained window without hiding prior entries', async (t) => {
  const measured = instrument(t),
    f = await fixture(t),
    target = await f.create();
  const watch = observe(t, f.client, target);
  const first = await watch.wait((view) => view.state === 'idle');
  const before = measured.counts.scans;
  await (await measured.harness().conversation(conversationId(target), context))!.reset(
    undefined,
    context,
  );
  const next = await watch.wait((view) => view.transcriptBoundary !== first.transcriptBoundary);
  assert(measured.counts.scans > before);
  assert(
    next.entries.some((entry) =>
      entry.transcript?.parts.some((part) => part.text.includes('reset')),
    ),
  );
  for (const entry of first.entries)
    assert(next.entries.some((candidate) => candidate.id === entry.id));
  assert.deepEqual(watch.errors, []);
});
