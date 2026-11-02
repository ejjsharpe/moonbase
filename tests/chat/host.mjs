// Controlled host process composition root; public SDK/service APIs only, no provider network.
import { hostControl } from './host-control.mjs';
import { readFileSync } from 'node:fs';
import { ManagedRuntime, Effect } from 'effect';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { PiRuntimeLive } from '@moonbase/pi-runtime';
import { serveChat } from '@moonbase/pi-runtime/server';
import { makeChatClient } from '@moonbase/application/runtime/clients';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const faux = fauxProvider({ tokensPerSecond: 100000 }),
  models = createModels();
models.setProvider(faux.provider);
let release;
const gate = config.hold
  ? new Promise((resolve) => {
      release = resolve;
    })
  : Promise.resolve();
faux.setResponses([
  async () => {
    await gate;
    return fauxAssistantMessage('REMOTE COMPLETED');
  },
]);
const runtime = ManagedRuntime.make(
  PiRuntimeLive({
    ...config.session,
    cwd: config.cwd,
    databasePath: config.databasePath,
    model: { provider: faux.provider.id, modelId: faux.getModel().id },
    models,
  }),
);
const client = makeChatClient(runtime);
const { bound, ended, close } = hostControl(
  client,
  () => ({ calls: faux.state.callCount, tools: 0 }),
  () => release?.(),
);
try {
  await runtime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveChat(
          { host: config.session.host, token: config.token, port: 0 },
          bound,
        );
        process.send?.({ event: 'ready', origin: server.origin });
        yield* Effect.promise(() => ended);
      }),
    ),
  );
} catch {
  process.send?.({ event: 'failed' });
  process.exitCode = 1;
} finally {
  await runtime.dispose();
  close();
  if (process.connected) process.disconnect();
}
