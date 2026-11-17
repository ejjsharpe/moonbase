import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cause, Effect, Exit, Layer, ManagedRuntime } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { isChatError } from '@moonbase/contracts/chat-errors';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { makeChatClient } from '@moonbase/application/chat/clients';
import { type Registry } from '@earendil-works/pi-durable';
import { LocalPiRuntimeLive, type LocalPiRuntimeConfiguration } from '../src/index.ts';

/** The runtime with the platform services a process root would give it. */
export const localPiRuntime = (config: LocalPiRuntimeConfiguration) =>
  LocalPiRuntimeLive(config).pipe(Layer.provide(NodeServices.layer));
export const session = {
  host: { hostId: 'test-host', storeId: 'test-store' },
  actorId: 'personal',
};
/** Whether a process exists; a test checks this for processes it started. */
export const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ESRCH') return false;
    throw error;
  }
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
  const layer = localPiRuntime({
    ...session,
    databasePath: config.databasePath,
    models,
    registry,
  });
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
    settings,
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
    /** Disposes, returning the chat errors its cleanup failed with. */
    async disposeObserved() {
      const exit = await Effect.runPromiseExit(runtime.disposeEffect);
      return Exit.isFailure(exit)
        ? exit.cause.reasons.flatMap((reason) =>
            Cause.isDieReason(reason) && isChatError(reason.defect) ? [reason.defect] : [],
          )
        : [];
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
