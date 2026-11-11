import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedRuntime } from 'effect';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { LocalPiRuntimeLive } from '@moonbase/pi-runtime';
import { ApplicationError } from '@moonbase/contracts/errors';
import { makeChatClient } from '@moonbase/application/runtime/clients';
import { ChatIpcSession } from '../src/chat/session.ts';

test('desktop recovers an exact committed Create before renewed folder approval, while new Create still requires approval', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-local-retry-'))),
    cwd = join(root, 'folder');
  await mkdir(cwd);
  const models = createModels(),
    faux = fauxProvider();
  models.setProvider(faux.provider);
  const context = {
    host: { hostId: 'local-retry', storeId: 'local-retry-store' },
    actorId: 'owner',
  };
  let approved = true,
    validations = 0;
  const config = {
    ...context,
    models,
    databasePath: join(root, 'chat.sqlite'),
    approveCreation: async () => {
      validations++;
      if (!approved)
        throw new ApplicationError({ code: 'Unauthorized', message: 'Choose a working folder.' });
    },
  };
  let runtime = ManagedRuntime.make(LocalPiRuntimeLive(config));
  await makeChatClient(runtime).command('getChatHost', { host: context.host });
  let owner = new ChatIpcSession(
    runtime,
    makeChatClient(runtime),
    { mode: 'local' },
    context,
    () => {},
  );
  t.after(async () => {
    await owner.dispose();
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const input = {
    session: context,
    requestId: 'original',
    title: 'Committed',
    settings: { cwd, model: { provider: faux.provider.id, modelId: faux.getModel().id } },
  };
  const committed = await owner.call('chat', 'createChat', input, 'first');
  assert(committed.ok);
  assert.equal(validations, 1);
  await owner.dispose();
  await runtime.dispose();
  await rm(cwd, { recursive: true });
  approved = false;
  runtime = ManagedRuntime.make(LocalPiRuntimeLive(config));
  await makeChatClient(runtime).command('getChatHost', { host: context.host });
  owner = new ChatIpcSession(
    runtime,
    makeChatClient(runtime),
    { mode: 'local' },
    context,
    () => {},
  );
  assert.deepEqual(await owner.call('chat', 'createChat', input, 'retry'), committed);
  assert.equal(validations, 1);
  await mkdir(cwd);
  const denied = await owner.call('chat', 'createChat', { ...input, requestId: 'new' }, 'new');
  assert(!denied.ok && denied.error.code === 'Unauthorized');
  assert.equal(validations, 2);
});
