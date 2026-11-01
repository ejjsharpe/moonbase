import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Effect, ManagedRuntime } from 'effect';
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { createRegistry } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { makeChatClient } from '@moonbase/application/runtime-client';
import { releaseResource } from '@moonbase/application/services';
import { PiRuntimeLive } from './index.ts';
import { serveChat } from './server.ts';
import * as V from './validation.ts';
import * as P from './protocol.ts';

/** Standalone process composition root; feature services never create runtimes. */
async function main() {
  if (process.argv.length !== 3 || !isAbsolute(process.argv[2]))
    V.fail('InvalidInput', 'Supply an absolute private host configuration file.');
  const bytes = await readFile(process.argv[2]);
  if (bytes.length > 64 * 1024) V.fail('InvalidInput', 'Host configuration exceeds its bound.');
  const data = V.object(P.json(bytes), [
    'host',
    'actorId',
    'cwd',
    'databasePath',
    'model',
    'token',
    'port',
  ]);
  const session = V.session({ host: data.host, actorId: data.actorId }),
    model = V.object(data.model, ['provider', 'modelId']);
  const models = createModels();
  models.setProvider(openaiProvider());
  models.setProvider(anthropicProvider());
  const selected = { provider: V.id(model.provider), modelId: V.string(model.modelId, 256) },
    configured = models.getModel(selected.provider, selected.modelId);
  if (!configured || !(await models.getAuth(configured)))
    V.fail(
      'Unavailable',
      'Configure an installed model and existing host-side provider credentials.',
    );
  const registry = createRegistry();
  registry.install(CodingTools);
  const config = {
    ...session,
    cwd: V.string(data.cwd, 4096),
    databasePath: V.string(data.databasePath, 4096),
    model: selected,
    models,
    registry,
  };
  if (!Number.isInteger(data.port) || Number(data.port) < 1 || Number(data.port) > 65535)
    V.fail('InvalidInput', 'Configure an explicit loopback host port.');
  const token = P.token(data.token),
    runtime = ManagedRuntime.make(PiRuntimeLive(config)),
    client = makeChatClient(runtime);
  try {
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let resolve!: () => void;
          const ended = new Promise<void>((done) => (resolve = done));
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const stop = () => resolve();
              process.once('SIGTERM', stop);
              process.once('SIGINT', stop);
              return () => {
                process.off('SIGTERM', stop);
                process.off('SIGINT', stop);
              };
            }),
            (off) => releaseResource(off),
          );
          yield* serveChat({ host: session.host, token, port: Number(data.port) }, client);
          console.log(JSON.stringify({ event: 'ready', host: session.host }));
          yield* Effect.promise(() => ended);
        }),
      ),
    );
  } finally {
    await runtime.dispose();
  }
}
await main().catch((error) => {
  console.error(JSON.stringify({ event: 'failed', error: P.publicError(error) }));
  process.exitCode = 1;
});
