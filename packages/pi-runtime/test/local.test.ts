import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Harness } from '@earendil-works/pi-durable';
import { mkdtemp, mkdir, readFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Effect, ManagedRuntime } from 'effect';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { makeChatClient } from '@moonbase/application/runtime/clients';
import { LocalPiRuntimeLive, LocalPiControl, PiRuntimeLive } from '../src/index.ts';

const session = { host: { hostId: 'local-test', storeId: 'local-store' }, actorId: 'local-owner' };
async function until<A>(read: () => Promise<A>, ready: (value: A) => boolean) {
  for (let i = 0; i < 300; i++) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error('Local work did not settle');
}
test('local conversations retain distinct folders/models, coding tools, immutable creation and restart identity', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-local-')));
  const first = join(root, 'first'),
    second = join(root, 'second');
  await mkdir(first);
  await mkdir(second);
  const models = createModels(),
    faux = fauxProvider({
      models: [
        { id: 'first-model', reasoning: true },
        { id: 'second-model', reasoning: true },
      ],
      tokensPerSecond: 100000,
    });
  models.setProvider({
    ...faux.provider,
    getModels: () =>
      faux.models.map((model) => ({ ...model, thinkingLevelMap: { xhigh: 'xhigh' } })),
  });
  const config = { ...session, databasePath: join(root, 'local.sqlite'), models };
  let runtime = ManagedRuntime.make(LocalPiRuntimeLive(config));
  t.after(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  let client = makeChatClient(runtime);
  assert.deepEqual(await client.command('getChatHost', { host: session.host }), {
    ...session,
    mode: 'local',
    features: ['transcript-v1'],
  });
  await assert.rejects(
    client.command('createChat', { session, requestId: 'missing', title: 'No settings' }),
    { code: 'InvalidInput' },
  );
  const inputs = [first, second].map((cwd, index) => ({
    session,
    requestId: 'create-' + index,
    title: 'Local ' + index,
    settings: {
      cwd,
      model: { provider: faux.provider.id, modelId: index ? 'second-model' : 'first-model' },
      reasoningEffort: index ? ('xhigh' as const) : ('high' as const),
    },
  }));
  const chats = await Promise.all(inputs.map((input) => client.command('createChat', input)));
  assert.deepEqual(
    chats.map((chat) => chat.conversation.reasoningEffort),
    ['high', 'xhigh'],
  );
  await assert.rejects(
    client.command('createChat', {
      ...inputs[0],
      requestId: 'unsupported-effort',
      settings: { ...inputs[0].settings, reasoningEffort: 'max' },
    }),
    { code: 'InvalidInput' },
  );
  assert.deepEqual(
    chats.map((chat) => chat.conversation.cwd),
    [first, second],
  );
  assert.deepEqual(
    chats.map((chat) => chat.conversation.model),
    ['faux/first-model', 'faux/second-model'],
  );
  await assert.rejects(
    client.command('createChat', { ...inputs[0], settings: inputs[1].settings }),
    { code: 'InvalidInput' },
  );
  for (let i = 0; i < 2; i++) {
    faux.setResponses([
      (_context, options, _state, model) => {
        assert.equal(model.id, inputs[i].settings.model.modelId);
        assert.equal(options?.reasoning, inputs[i].settings.reasoningEffort);
        return fauxAssistantMessage(
          fauxToolCall('write', { path: 'result.txt', content: 'folder-' + i }),
          { stopReason: 'toolUse' },
        );
      },
      fauxAssistantMessage('Saved locally'),
    ]);
    const target = chats[i].conversation.target;
    await client.command('sendChat', {
      target,
      requestId: 'send-' + i,
      text: 'Write in this folder',
    });
    await until(
      () => client.command('getChat', { target }),
      (snapshot) =>
        !snapshot.run && snapshot.entries.some((entry) => entry.text === 'Saved locally'),
    );
    assert.equal(await readFile(join(inputs[i].settings.cwd, 'result.txt'), 'utf8'), 'folder-' + i);
  }
  await runtime.dispose();
  runtime = ManagedRuntime.make(LocalPiRuntimeLive(config));
  client = makeChatClient(runtime);
  assert.deepEqual(await client.command('createChat', inputs[0]), chats[0]);
  assert.equal(
    (await client.command('getChat', { target: chats[1].conversation.target })).conversation
      .reasoningEffort,
    'xhigh',
  );
  faux.setResponses([
    (_context, options) => {
      assert.equal(options?.reasoning, 'xhigh');
      return fauxAssistantMessage('Resumed with the captured effort');
    },
  ]);
  await client.command('sendChat', {
    target: chats[1].conversation.target,
    requestId: 'after-restart',
    text: 'Continue',
  });
  await until(
    () => client.command('getChat', { target: chats[1].conversation.target }),
    (snapshot) =>
      !snapshot.run &&
      snapshot.entries.some((entry) => entry.text === 'Resumed with the captured effort'),
  );
  assert.equal((await client.command('listChats', { session })).conversations.length, 2);
  await assert.rejects(
    client.command('listChats', {
      session: { ...session, host: { ...session.host, storeId: 'remote' } },
    }),
    { code: 'Incompatible' },
  );
  const control = await runtime.runPromise(LocalPiControl);
  control.setAdmissionsOpen(false);
  await assert.rejects(client.command('createChat', inputs[0]), { code: 'Unavailable' });
  assert.equal(await runtime.runPromise(control.hasActiveWork()), false);
  control.setAdmissionsOpen(true);
  assert.deepEqual(await client.command('createChat', inputs[0]), chats[0]);
  await rm(first, { recursive: true });
  assert.match(
    (await client.command('getChat', { target: chats[0].conversation.target })).message!,
    /working folder is unavailable/,
  );
  assert.deepEqual(await client.command('createChat', inputs[0]), chats[0]);
  const remote = ManagedRuntime.make(
    PiRuntimeLive({ ...config, cwd: first, model: inputs[0].settings.model }),
  );
  await assert.rejects(makeChatClient(remote).command('getChatHost', { host: session.host }));
  await remote.dispose();
});

test('Quit control sees hidden work and gates unfinished local mutations without Stop', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-local-active-')));
  const models = createModels(),
    faux = fauxProvider({ tokensPerSecond: 2 });
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage('This local generation stays active long enough to inspect all work.'),
  ]);
  const runtime = ManagedRuntime.make(
    LocalPiRuntimeLive({ ...session, models, databasePath: join(directory, 'chat.sqlite') }),
  );
  t.after(async () => {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const client = makeChatClient(runtime),
    control = await runtime.runPromise(LocalPiControl);
  const { conversation } = await client.command('createChat', {
    session,
    requestId: 'create',
    title: 'Hidden',
    settings: {
      cwd: directory,
      model: { provider: faux.provider.id, modelId: faux.getModel().id },
    },
  });
  await client.command('sendChat', { target: conversation.target, requestId: 'send', text: 'Run' });
  control.setAdmissionsOpen(false);
  assert.equal(await runtime.runPromise(control.hasActiveWork()), true);
  control.setAdmissionsOpen(true);
  const snapshot = await client.command('getChat', { target: conversation.target });
  assert.equal(snapshot.state, 'running');
  assert.equal(Effect.isEffect(control.hasActiveWork()), true);
});

test('Quit still sees a root-owned Create admission after its caller cancels the wait', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-local-admission-')));
  const models = createModels(),
    faux = fauxProvider();
  models.setProvider(faux.provider);
  const runtime = ManagedRuntime.make(
    LocalPiRuntimeLive({ ...session, models, databasePath: join(directory, 'chat.sqlite') }),
  );
  const released = Promise.withResolvers<void>(),
    started = Promise.withResolvers<void>();
  let harness!: Harness;
  const originalOpen = Harness.open;
  const opening = t.mock.method(
    Harness,
    'open',
    async (...args: Parameters<typeof originalOpen>) => (harness = await originalOpen(...args)),
  );
  const client = makeChatClient(runtime),
    control = await runtime.runPromise(LocalPiControl);
  opening.mock.restore();
  let intercept = true;
  const commit = harness.commit.bind(harness);
  const patched = t.mock.method(harness, 'commit', async (...args: Parameters<typeof commit>) => {
    if (intercept) {
      intercept = false;
      started.resolve();
      await released.promise;
    }
    return commit(...args);
  });
  t.after(async () => {
    released.resolve();
    patched.mock.restore();
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const abort = new AbortController();
  const create = client.command(
    'createChat',
    {
      session,
      requestId: 'held-create',
      title: 'Held',
      settings: {
        cwd: directory,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
      },
    },
    { signal: abort.signal },
  );
  await started.promise;
  abort.abort();
  await assert.rejects(create, { code: 'Cancelled' });
  control.setAdmissionsOpen(false);
  assert.equal(await runtime.runPromise(control.hasActiveWork()), true);
  released.resolve();
  await until(
    () => client.command('listChats', { session }),
    (page) => page.conversations.length === 1,
  );
  await until(
    () => runtime.runPromise(control.hasActiveWork()),
    (active) => !active,
  );
});

test('Quit counts Send metadata validation as unfinished root-owned admission', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-local-preflight-')));
  const models = createModels(),
    faux = fauxProvider({ tokensPerSecond: 100000 });
  models.setProvider(faux.provider);
  let harness!: Harness;
  const open = Harness.open;
  const opening = t.mock.method(
    Harness,
    'open',
    async (...args: Parameters<typeof open>) => (harness = await open(...args)),
  );
  const runtime = ManagedRuntime.make(
    LocalPiRuntimeLive({ ...session, models, databasePath: join(directory, 'chat.sqlite') }),
  );
  const client = makeChatClient(runtime),
    control = await runtime.runPromise(LocalPiControl);
  opening.mock.restore();
  const { conversation } = await client.command('createChat', {
    session,
    requestId: 'create',
    title: 'Preflight',
    settings: {
      cwd: directory,
      model: { provider: faux.provider.id, modelId: faux.getModel().id },
    },
  });
  const started = Promise.withResolvers<void>(),
    released = Promise.withResolvers<void>();
  const snapshot = harness.snapshot.bind(harness);
  let intercept = true;
  const patched = t.mock.method(
    harness,
    'snapshot',
    async (...args: Parameters<typeof snapshot>) => {
      if (intercept) {
        intercept = false;
        started.resolve();
        await released.promise;
      }
      return snapshot(...args);
    },
  );
  t.after(async () => {
    released.resolve();
    patched.mock.restore();
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  faux.setResponses([fauxAssistantMessage('Done')]);
  const send = client.command('sendChat', {
    target: conversation.target,
    requestId: 'send',
    text: 'Question',
  });
  await started.promise;
  control.setAdmissionsOpen(false);
  assert.equal(await runtime.runPromise(control.hasActiveWork()), true);
  released.resolve();
  assert.equal((await send).admission, 'admitted');
});
