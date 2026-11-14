import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ManagedRuntime } from 'effect';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { LocalPiRuntimeLive } from '@moonbase/chat-runtime';
import { createMoonbaseApplication } from '@moonbase/application';
import { makeChatClient } from '@moonbase/application/runtime/clients';
import type { ChatState } from '@moonbase/application/chat';
import { controlledHostFixture, until } from './fixture.ts';

function storage() {
  let value: string | null = null;
  return {
    read: () => value,
    write: (next: string) => {
      value = next;
    },
  };
}

test('public local controller receives successive Pi text before held completion, hydrates exact sources, and Stop stays independent of held reads', async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'moonbase-transcript-controller-')),
  );
  const faux = fauxProvider({ tokensPerSecond: 100000 }),
    models = createModels();
  models.setProvider(faux.provider);
  const stream = createAssistantMessageEventStream();
  const original = faux.provider.streamSimple.bind(faux.provider);
  faux.provider.streamSimple = (...args) => {
    args[2]?.signal?.addEventListener(
      'abort',
      () => stream.end(fauxAssistantMessage('first second', { stopReason: 'aborted' })),
      { once: true },
    );
    return stream;
  };
  const session = { host: { hostId: 'local-controller', storeId: 'temporary' }, actorId: 'actor' };
  const runtime = ManagedRuntime.make(
    LocalPiRuntimeLive({ ...session, databasePath: join(directory, 'chat.sqlite'), models }),
  );
  const client = makeChatClient(runtime);
  const gate = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  let hold = false;
  const app = await createMoonbaseApplication({
    chat: async () => ({
      mode: 'local',
      context: session,
      storage: storage(),
      chat: {
        watch: client.watch,
        watchChatList: client.watchChatList,
        async command(operation, input, options) {
          if (hold && operation === 'getChatTranscriptContent') {
            entered.resolve();
            await gate.promise;
          }
          return client.command(operation, input, options);
        },
      },
    }),
  });
  const controller = app.chat!;
  try {
    await controller.start();
    await controller.create('Local progressive', {
      cwd: directory,
      model: { provider: faux.provider.id, modelId: faux.getModel().id },
    });
    await until(
      async () => controller.getSnapshot(),
      (state) => !!state.snapshot,
    );
    const views: ChatState[] = [];
    const off = controller.subscribe(() => views.push(controller.getSnapshot()));
    controller.setDraft('held generation');
    await controller.send();
    await until(
      async () => controller.getSnapshot(),
      (state) => !!state.snapshot?.run,
    );
    stream.push({
      type: 'text_delta',
      contentIndex: 0,
      delta: 'first',
      partial: fauxAssistantMessage('first'),
    });
    await until(
      async () => controller.getSnapshot(),
      (state) => state.snapshot?.run?.text === 'first',
    );
    stream.push({
      type: 'text_delta',
      contentIndex: 0,
      delta: ' second',
      partial: fauxAssistantMessage('first second'),
    });
    const active = await until(
      async () => controller.getSnapshot(),
      (state) => state.snapshot?.run?.text === 'first second',
    );
    const transcript = active.snapshot!.run!.transcript!,
      descriptor = transcript.parts[0];
    await controller.loadTranscriptPart(transcript.source, {
      partId: descriptor.partId,
      revision: descriptor.revision,
      bytes: descriptor.bytes,
    });
    assert.equal(controller.getSnapshot().transcript.content[0].chunks[0].data, 'first second');
    hold = true;
    const read = controller.loadTranscriptManifest(transcript.source);
    await entered.promise;
    controller.setDraft('draft while reading');
    await controller.stop();
    assert.equal(controller.getSnapshot().draft, 'draft while reading');
    assert(views.some((view) => view.snapshot?.run?.text === 'first'));
    assert(views.some((view) => view.snapshot?.run?.text === 'first second'));
    gate.resolve();
    await read;
    off();
    await until(
      async () => controller.getSnapshot(),
      (state) => !state.snapshot?.run,
    );
  } finally {
    gate.resolve();
    stream.end(fauxAssistantMessage('first second', { stopReason: 'aborted' }));
    faux.provider.streamSimple = original;
    await app.dispose();
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('public remote controller consumes authenticated successive replacements before held completion without additional history/content reads', async (t) => {
  const fixture = await controlledHostFixture(new URL('./faux-stream.mjs', import.meta.url), true);
  const root = fixture.root();
  const app = await createMoonbaseApplication({
    chat: async () => ({
      chat: root.chat,
      // The remote host is the daemon in host mode: local-mode chats over a connection.
      mode: 'local',
      connection: root.connection,
      context: fixture.session,
      storage: storage(),
    }),
  });
  t.after(async () => {
    fixture.release();
    await app.dispose();
    await fixture.close();
  });
  const controller = app.chat!;
  await controller.start();
  await controller.connect();
  await until(
    async () => controller.getSnapshot(),
    (state) => !!state.host,
  );
  await controller.create('Remote progressive', fixture.settings);
  await until(
    async () => controller.getSnapshot(),
    (state) => !!state.snapshot,
  );
  controller.setDraft('remote progress');
  await controller.send();
  const first = await until(
    async () => controller.getSnapshot(),
    (state) => state.snapshot?.run?.text === 'first remote text 0',
  );
  const entries = first.transcript.entries;
  const before = await fixture.stats();
  fixture.nextChunk();
  const second = await until(
    async () => controller.getSnapshot(),
    (state) => state.snapshot?.run?.text === 'first remote text 4',
  );
  assert.equal(second.transcript.entries, entries);
  assert.equal(second.transcript.observation, 'streaming');
  const after = await fixture.stats();
  assert.deepEqual(after.reads, before.reads);
  assert.equal(
    after.commands.filter((command) =>
      ['getChatHistory', 'getChatTranscriptContent'].includes(command),
    ).length,
    0,
  );
  fixture.release();
  await until(
    async () => controller.getSnapshot(),
    (state) =>
      !state.snapshot?.run &&
      state.transcript.entries.some((entry) => entry.text === 'REMOTE COMPLETED'),
  );
  assert.equal(
    controller.getSnapshot().transcript.entries.filter((entry) => entry.text === 'REMOTE COMPLETED')
      .length,
    1,
  );
});

test('two clients of one daemon see the same chat list changes and streamed text without listing again', async (t) => {
  const fixture = await controlledHostFixture(new URL('./faux-stream.mjs', import.meta.url), true);
  const open = async () => {
    const root = fixture.root(),
      calls = { listings: 0 };
    const app = await createMoonbaseApplication({
      chat: async () => ({
        // Counts this client's own listings.
        chat: {
          ...root.chat,
          command: (operation, input, options) => {
            if (operation === 'listChats') calls.listings++;
            return root.chat.command(operation, input, options);
          },
        },
        mode: 'local',
        connection: root.connection,
        context: fixture.session,
        storage: storage(),
      }),
    });
    const controller = app.chat!;
    await controller.start();
    await controller.connect();
    await until(
      async () => controller.getSnapshot(),
      (state) => state.ready,
    );
    return { app, controller, calls };
  };
  const a = await open(),
    b = await open();
  t.after(async () => {
    fixture.release();
    await Promise.all([a.app.dispose(), b.app.dispose()]);
    await fixture.close();
  });
  const listed = a.calls.listings;
  const row = (state: ChatState) => state.chats.find((chat) => chat.title === 'Shared chat');
  // A creates and sends; B's list shows the chat appear and start running.
  await a.controller.create('Shared chat', fixture.settings);
  await until(
    async () => a.controller.getSnapshot(),
    (state) => !!state.snapshot,
  );
  a.controller.setDraft('shared progress');
  await a.controller.send();
  const running = await until(
    async () => b.controller.getSnapshot(),
    (state) => row(state)?.activity?.state === 'running',
  );
  // B opens it and streams the same text as A, before the run completes.
  await b.controller.select(row(running)!.target);
  for (const { controller } of [a, b])
    await until(
      async () => controller.getSnapshot(),
      (state) => state.snapshot?.run?.text === 'first remote text 0',
    );
  fixture.nextChunk();
  for (const { controller } of [a, b])
    await until(
      async () => controller.getSnapshot(),
      (state) => state.snapshot?.run?.text === 'first remote text 4',
    );
  // Finishing the run, then settling and unsettling from B, reach A's list.
  fixture.release();
  await until(
    async () => a.controller.getSnapshot(),
    (state) => row(state)?.activity?.state === 'idle',
  );
  await b.controller.settle(row(running)!.target, true);
  await until(
    async () => a.controller.getSnapshot(),
    (state) => !!row(state)?.settledAt,
  );
  await b.controller.settle(row(running)!.target, false);
  await until(
    async () => a.controller.getSnapshot(),
    (state) => !!row(state) && !row(state)!.settledAt,
  );
  for (const { controller } of [a, b])
    assert.equal(
      controller
        .getSnapshot()
        .transcript.entries.filter((entry) => entry.text === 'REMOTE COMPLETED').length,
      1,
    );
  // A saw every change from its list watch and never listed again; nothing lists on a timer.
  assert.equal(a.calls.listings, listed);
});
