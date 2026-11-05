import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedRuntime } from 'effect';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { makeChatClient } from '@moonbase/application/runtime/clients';
import { type Registry } from '@earendil-works/pi-durable';
import { PiRuntimeLive, LocalPiRuntimeLive } from '../src/index.ts';
import { runApplicationEffect } from '@moonbase/application/runtime/effect-client';

export const session = {
  host: { hostId: 'test-host', storeId: 'test-store' },
  actorId: 'personal',
};
export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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
  local = false,
) {
  const directory = await mkdtemp(join(tmpdir(), 'moonbase-pi-')),
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
  const layer = local
    ? LocalPiRuntimeLive({ ...session, databasePath: config.databasePath, models, registry })
    : PiRuntimeLive(config);
  let runtime = ManagedRuntime.make(layer);
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
    get runtime() {
      return runtime;
    },
    get client() {
      return makeChatClient(runtime);
    },
    async restart() {
      await runtime.dispose();
      runtime = ManagedRuntime.make(layer);
    },
    async dispose() {
      await runtime.dispose();
    },
    async disposeObserved() {
      await runApplicationEffect(runtime, runtime.disposeEffect);
    },
    async create(requestId = 'create') {
      return (
        await makeChatClient(runtime).command('createChat', {
          session,
          requestId,
          title: 'Saved chat',
          ...(local ? { settings: { cwd: await realpath(directory), model: config.model } } : {}),
        })
      ).conversation.target;
    },
  };
}
