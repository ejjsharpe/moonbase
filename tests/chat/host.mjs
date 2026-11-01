// Controlled host process composition root; public SDK/service APIs only, no provider network.
import { readFileSync } from 'node:fs';
import { ManagedRuntime, Effect } from 'effect';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { PiRuntimeLive } from '@moonbase/pi-runtime';
import { serveChat } from '@moonbase/pi-runtime/server';
import { makeChatClient } from '@moonbase/application/runtime-client';

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
let end;
const ended = new Promise((resolve) => {
  end = resolve;
});
const commands = [];
let replyOperation,
  replyGate = Promise.resolve(),
  releaseReply = () => {};
const heldReplies = [];
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
const bound = {
  command: async (...args) => {
    commands.push(args[0]);
    const result = await client.command(...args);
    if (args[0] === replyOperation) {
      heldReplies.push(args[0]);
      await replyGate;
    }
    return result;
  },
  watch: client.watch,
};
const control = (message) => {
  if (message?.type === 'stats')
    process.send?.({
      id: message.id,
      calls: faux.state.callCount,
      commands: [...commands],
      replyOperation,
      heldReplies: [...heldReplies],
    });
  if (message?.type === 'hold-reply') {
    replyOperation = message.operation;
    replyGate = new Promise((resolve) => {
      releaseReply = resolve;
    });
  }
  if (message?.type === 'release-reply') {
    replyOperation = undefined;
    releaseReply();
  }
  if (message?.type === 'release') release?.();
  if (message?.type === 'shutdown') {
    release?.();
    releaseReply();
    end();
  }
};
process.on('message', control);
process.once('disconnect', () => {
  release?.();
  releaseReply();
  end();
});
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
  process.off('message', control);
  if (process.connected) process.disconnect();
}
