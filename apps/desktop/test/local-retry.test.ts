import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer, ManagedRuntime } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { LocalPiRuntimeLive } from '@moonbase/chat-runtime';
import type { ChatSession } from '@moonbase/contracts/chat';
import { FolderRefusedError } from '@moonbase/contracts/folder-errors';
import { makeChatClient } from '@moonbase/application/chat/clients';
import { ChatIpcSession } from '../src/main/chat/session.ts';
import { makeIpcFixture, noChat } from './fixtures/ipc-fixture.ts';

/** Local chat over desktop IPC, as the renderer sends it, to `runtime`'s chat. */
const overIpc = (runtime: ManagedRuntime.ManagedRuntime<never, never>, context: ChatSession) => {
  const session = new ChatIpcSession(makeChatClient(runtime as never), { mode: 'local' }, context);
  return makeIpcFixture({
    chat: {
      backends: {
        ...noChat,
        getTargets: () => [{ id: 'local', label: 'Local', mode: 'local' }],
        getSession: () => session,
      },
    },
  });
};

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
    approveCreation: () =>
      Effect.suspend(() => {
        validations++;
        return approved
          ? Effect.void
          : Effect.fail(new FolderRefusedError({ refusal: 'not-approved' }));
      }),
  };
  let runtime = ManagedRuntime.make(
    Layer.orDie(LocalPiRuntimeLive(config).pipe(Layer.provide(NodeServices.layer))),
  );
  await makeChatClient(runtime).command('getChatHost', { host: context.host });
  let ipc = await overIpc(runtime as never, context);
  t.after(async () => {
    await ipc.dispose();
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const input = {
    session: context,
    requestId: 'original',
    title: 'Committed',
    settings: { cwd, model: { provider: faux.provider.id, modelId: faux.getModel().id } },
  };
  const committed = await Effect.runPromise((await ipc.ports('local')).chat.createChat(input));
  assert.equal(validations, 1);
  await ipc.dispose();
  await runtime.dispose();
  await rm(cwd, { recursive: true });
  approved = false;
  runtime = ManagedRuntime.make(
    Layer.orDie(LocalPiRuntimeLive(config).pipe(Layer.provide(NodeServices.layer))),
  );
  await makeChatClient(runtime).command('getChatHost', { host: context.host });
  ipc = await overIpc(runtime as never, context);
  const { chat } = await ipc.ports('local');
  assert.deepEqual(await Effect.runPromise(chat.createChat(input)), committed);
  assert.equal(validations, 1);
  await mkdir(cwd);
  await assert.rejects(Effect.runPromise(chat.createChat({ ...input, requestId: 'new' })), {
    code: 'Unauthorized',
  });
  assert.equal(validations, 2);
});
