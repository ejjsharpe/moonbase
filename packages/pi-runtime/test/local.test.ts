import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Harness } from '@earendil-works/pi-durable';
import { mkdtemp, mkdir, readFile, readdir, rm, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
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

test('a local chat without a project runs in a new, empty folder of its own', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-own-folder-')));
  const chatFolders = join(root, 'chats');
  const models = createModels(),
    faux = fauxProvider({ models: [{ id: 'model' }], tokensPerSecond: 100000 });
  models.setProvider(faux.provider);
  const approvals: unknown[] = [];
  let refuse = false;
  const config = {
    ...session,
    databasePath: join(root, 'local.sqlite'),
    models,
    approveCreation: async (settings: unknown) => {
      approvals.push(settings);
      if (refuse) throw new Error('refused');
    },
  };
  let runtime = ManagedRuntime.make(LocalPiRuntimeLive(config));
  t.after(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  let client = makeChatClient(runtime);
  const settings = { model: { provider: faux.provider.id, modelId: 'model' } };
  const input = (requestId: string, title = requestId) => ({ session, requestId, title, settings });
  // A host with nowhere to make chat folders still requires one.
  await assert.rejects(client.command('createChat', input('nowhere')), { code: 'InvalidInput' });
  await runtime.dispose();
  runtime = ManagedRuntime.make(LocalPiRuntimeLive({ ...config, chatFolders }));
  client = makeChatClient(runtime);
  refuse = true;
  await assert.rejects(client.command('createChat', input('refused')));
  assert.deepEqual(approvals.at(-1), settings);
  // A refused chat leaves no folder behind.
  await assert.rejects(readdir(chatFolders), { code: 'ENOENT' });
  refuse = false;
  const title = 'Convert these PNGs to WebP, please!';
  const first = await client.command('createChat', input('first', title));
  const second = await client.command('createChat', input('second', '☕'));
  const folders = [first, second].map((chat) => chat.conversation.cwd);
  assert.equal(new Set(folders).size, 2);
  for (const folder of folders) {
    assert.equal(dirname(folder), chatFolders);
    assert.deepEqual(await readdir(folder), []);
  }
  // Named for the day, the title's first words and a short id.
  const day = String.raw`\d{4}-\d{2}-\d{2}`;
  assert.match(
    basename(folders[0]!),
    RegExp(`^${day}-convert-these-pngs-to-webp-please-[a-f0-9]{8}$`),
  );
  assert.match(basename(folders[1]!), RegExp(`^${day}-[a-f0-9]{8}$`));
  assert.equal(first.conversation.ownFolder, true);
  // Retrying the same request returns the same chat and makes no other folder.
  assert.deepEqual(await client.command('createChat', input('first', title)), first);
  assert.equal((await readdir(chatFolders)).length, 2);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('write', { path: 'notes.txt', content: 'own folder' }), {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('Written'),
  ]);
  const target = first.conversation.target;
  await client.command('sendChat', { target, requestId: 'send', text: 'Take notes' });
  await until(
    () => client.command('getChat', { target }),
    (snapshot) => !snapshot.run && snapshot.entries.some((entry) => entry.text === 'Written'),
  );
  assert.equal(await readFile(join(folders[0]!, 'notes.txt'), 'utf8'), 'own folder');
  await runtime.dispose();
  runtime = ManagedRuntime.make(LocalPiRuntimeLive({ ...config, chatFolders }));
  client = makeChatClient(runtime);
  const listed = (await client.command('listChats', { session })).conversations;
  assert.deepEqual(
    listed.map((chat) => [chat.cwd, chat.ownFolder]).sort(),
    folders.map((folder) => [folder, true]).sort(),
  );
  assert.equal((await client.command('getChat', { target })).conversation.ownFolder, true);
  // Once its folder becomes a project, the chat lists under it, in the same folder with its files.
  const control = await runtime.runPromise(LocalPiControl);
  await runtime.runPromise(control.markFolderAsProject(target));
  await runtime.runPromise(control.markFolderAsProject(target));
  const adopted = (await client.command('getChat', { target })).conversation;
  assert.equal(adopted.ownFolder, undefined);
  assert.equal(adopted.cwd, folders[0]);
  assert.equal(await readFile(join(folders[0]!, 'notes.txt'), 'utf8'), 'own folder');
  const relisted = (await client.command('listChats', { session })).conversations;
  assert.deepEqual(
    relisted.map((chat) => [chat.cwd, chat.ownFolder ?? false]).sort(),
    [
      [folders[0], false],
      [folders[1], true],
    ].sort(),
  );
  // An original and its retry racing make one chat, and leave no unused folder behind.
  const raced = await Promise.all(
    [0, 1].map(() => client.command('createChat', input('raced', 'Raced'))),
  );
  assert.equal(raced[0].conversation.cwd, raced[1].conversation.cwd);
  assert.deepEqual(
    (await readdir(chatFolders)).sort(),
    [...folders, raced[0].conversation.cwd].map((folder) => basename(folder)).sort(),
  );
  // A foreign chat is refused.
  await assert.rejects(
    runtime.runPromise(control.markFolderAsProject({ ...target, actorId: 'someone-else' })),
    { code: 'Unauthorized' },
  );
});
test('a chat without a project is refused while its folders would sit inside a Git checkout', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-own-folder-git-')));
  await mkdir(join(root, '.git'));
  const models = createModels(),
    faux = fauxProvider({ models: [{ id: 'model' }] });
  models.setProvider(faux.provider);
  const runtime = ManagedRuntime.make(
    LocalPiRuntimeLive({
      ...session,
      databasePath: join(root, 'local.sqlite'),
      models,
      chatFolders: join(root, 'profile', 'chats'),
    }),
  );
  // Close the store before removing its folder: Bun's SQLite fails the closing checkpoint of a
  // deleted database.
  t.after(async () => {
    try {
      await runtime.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const settings = { model: { provider: faux.provider.id, modelId: 'model' } };
  await assert.rejects(
    makeChatClient(runtime).command('createChat', {
      session,
      requestId: 'git',
      title: 'Git',
      settings,
    }),
    { code: 'Unavailable' },
  );
  // Nothing was made for it.
  await assert.rejects(readdir(join(root, 'profile')), { code: 'ENOENT' });
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
