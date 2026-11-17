import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Layer, ManagedRuntime } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { makeChatClient } from '@moonbase/application/runtime/clients';
import { type Registry } from '@earendil-works/pi-durable';
import { LocalPiRuntimeLive } from '@moonbase/chat-runtime';
import { ChatService } from '@moonbase/contracts/services';

export const session = {
  host: { hostId: 'test-host', storeId: 'test-store' },
  actorId: 'personal',
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until<T>(get: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = await get();
    if (ready(value)) return value;
    await delay(10);
  }
  throw Error('Condition did not settle.');
}
export async function fixture(
  t: { after: (fn: () => Promise<void>) => void },
  registry?: Registry,
  fauxOptions: Parameters<typeof fauxProvider>[0] = {},
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-pi-'))),
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
  // Each chat's own folder and model, as a client's first Send names them.
  const settings = { cwd: directory, model: config.model };
  const layer = LocalPiRuntimeLive({
    ...session,
    databasePath: config.databasePath,
    models,
    registry,
  }).pipe(Layer.provide(NodeServices.layer));
  const runtime = ManagedRuntime.make(layer);
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
    settings,
    /** The runtime's chat service, as a daemon serves it. */
    chat: () => runtime.runPromise(ChatService),
    get client() {
      return makeChatClient(runtime);
    },
    async create(requestId = 'create') {
      return (
        await makeChatClient(runtime).command('createChat', {
          session,
          requestId,
          title: 'Saved chat',
          settings,
        })
      ).conversation.target;
    },
  };
}
