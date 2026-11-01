// Test-only composition: public Pi/SDK APIs, real SQLite, no provider/network or native tools.
import { readFileSync } from 'node:fs';
import { ManagedRuntime, Effect } from 'effect';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
} from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { PiRuntimeLive } from '@moonbase/pi-runtime';
import { serveChat } from '@moonbase/pi-runtime/server';
import { makeChatClient } from '@moonbase/application/runtime-client';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const models = createModels(),
  faux = fauxProvider({ tokensPerSecond: 100, tokenSize: { min: 4, max: 4 } });
models.setProvider(faux.provider);
let tools = 0,
  release;
const gate = config.hold ? new Promise((r) => (release = r)) : Promise.resolve();
const registry = createRegistry();
registry.install(
  defineExtension({
    name: 'proof-controlled',
    tools: [
      defineTool({
        name: 'inspect_remote_context',
        description: 'Controlled proof tool; does not inspect the real filesystem',
        parameters: Type.Object({}),
        execute: async (_input, api, ctx) => {
          tools++;
          api.output(
            'Controlled remote tool activity\nFixed folder observed by the test tool.\n' +
              'preview '.repeat(800),
          );
          await Promise.race([
            gate,
            new Promise((r) => {
              if (ctx.abortSignal?.aborted) return r();
              ctx.abortSignal?.addEventListener('abort', () => r(), { once: true });
            }),
          ]);
          return { output: [{ type: 'text', text: 'Controlled inspection completed' }] };
        },
      }),
    ],
  }),
);
const responses = Array.from({ length: 30 }, () => [
  fauxAssistantMessage(
    [
      fauxText('Inspecting the configured remote context.'),
      fauxToolCall('inspect_remote_context', {}),
    ],
    { stopReason: 'toolUse' },
  ),
  fauxAssistantMessage('Remote response finished. The saved conversation remains on the host.'),
]).flat();
faux.setResponses(responses);
const runtime = ManagedRuntime.make(
    PiRuntimeLive({
      ...config.session,
      cwd: config.cwd,
      databasePath: config.databasePath,
      model: { provider: faux.provider.id, modelId: faux.getModel().id },
      models,
      registry,
    }),
  ),
  client = makeChatClient(runtime),
  commands = [],
  mutations = [],
  heldReplies = [];
let replyOperation,
  replyGate = Promise.resolve(),
  releaseReply = () => {};
const bound = {
  command: async (...args) => {
    commands.push(args[0]);
    const result = await client.command(...args);
    if (['createChat', 'sendChat', 'stopChat'].includes(args[0]))
      mutations.push({
        operation: args[0],
        input: structuredClone(args[1]),
        result: structuredClone(result),
      });
    if (args[0] === replyOperation) {
      heldReplies.push(args[0]);
      await replyGate;
    }
    return result;
  },
  watch: client.watch,
};
let end;
const ended = new Promise((r) => (end = r));
const control = (message) => {
  if (message?.type === 'stats')
    process.send?.({
      id: message.id,
      calls: faux.state.callCount,
      tools,
      commands: [...commands],
      mutations: [...mutations],
      heldReplies: [...heldReplies],
      replyOperation,
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
