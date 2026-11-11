import { readFile, appendFile } from 'node:fs/promises';
import { Effect, ManagedRuntime } from 'effect';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { makeChatClient } from '@moonbase/application/runtime/clients';
import { chatHostCapabilities } from '@moonbase/contracts/host';
import { ApplicationError } from '@moonbase/contracts/errors';
import { LocalPiRuntimeLive } from '../src/index.ts';
import { serveChat } from '../src/server.ts';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const models = createModels(),
  faux = fauxProvider({
    provider: 'faux-host',
    models: [{ id: 'faux-model' }],
    tokensPerSecond: 100000,
    tokenSize: { min: 65536, max: 65536 },
  });
models.setProvider(faux.provider);
const record = (event) =>
  appendFile(config.log, JSON.stringify({ event, pid: process.pid }) + '\n');
faux.setResponses(
  Array.from({ length: 8 }, () => async (messages, options) => {
    await record('model');
    if (config.modelWait) {
      await new Promise((resolve) =>
        options.signal?.addEventListener('abort', resolve, { once: true }),
      );
      throw Error('Controlled interrupted model');
    }
    return messages.messages.some((m) => m.role === 'toolResult')
      ? fauxAssistantMessage('Resumed original input')
      : fauxAssistantMessage(fauxToolCall('counted', {}), { stopReason: 'toolUse' });
  }),
);
const registry = createRegistry();
registry.install(
  defineExtension({
    name: 'counted',
    tools: [
      defineTool({
        name: 'counted',
        description: 'Real counted fixture effect',
        parameters: Type.Object({}),
        execute: async (_, api, context) => {
          await record('tool');
          api.output('Counted effect is waiting');
          await api.details({ held: true }, context);
          await new Promise((resolve) => {
            if (context.abortSignal?.aborted) return resolve();
            context.abortSignal?.addEventListener('abort', resolve, { once: true });
          });
          return { output: [{ type: 'text', text: 'Interrupted fixture tool' }] };
        },
      }),
    ],
  }),
);
const runtime = ManagedRuntime.make(
    LocalPiRuntimeLive({
      host: config.host,
      actorId: config.actorId,
      databasePath: config.databasePath,
      models,
      registry,
    }),
  ),
  client = makeChatClient(runtime);
let ended;
const done = new Promise((resolve) => (ended = resolve));
process.once('SIGTERM', () => ended());
try {
  await runtime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // A local-mode chat host advertises local mode; it serves no other daemon operation.
        const daemon = {
          command: async () => {
            throw new ApplicationError({ code: 'Unavailable', message: 'Not served here.' });
          },
        };
        yield* serveChat(
          { host: config.host, token: config.token, port: config.port },
          client,
          daemon,
          [chatHostCapabilities.local],
        );
        console.log(JSON.stringify({ event: 'ready' }));
        yield* Effect.promise(() => done);
      }),
    ),
  );
} finally {
  await runtime.dispose();
}
