// Controlled host process composition root; public SDK/service APIs only, no provider network.
import { hostControl } from './host-control.mjs';
import { readFileSync } from 'node:fs';
import { ManagedRuntime, Effect } from 'effect';
import { Harness } from '@earendil-works/pi-durable';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { PiRuntimeLive } from '@moonbase/pi-runtime';
import { serveChat } from '@moonbase/pi-runtime/server';
import { makeChatClient } from '@moonbase/application/runtime/clients';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const faux = fauxProvider({ tokensPerSecond: 100000 }),
  models = createModels();
models.setProvider(faux.provider);
const reads = { scans: 0, entries: 0, inspections: 0 };
const open = Harness.open;
Harness.open = async (...args) => {
  const harness = await open(...args),
    commit = harness.commit.bind(harness),
    inspect = harness.inspect.bind(harness);
  harness.commit = (change, ctx) =>
    commit(
      (tx) =>
        change(
          new Proxy(tx, {
            get(object, key) {
              const value = Reflect.get(object, key);
              if (key === 'scanEntries')
                return (...values) => {
                  reads.scans++;
                  return value.apply(object, values);
                };
              if (key === 'entry')
                return (...values) => {
                  reads.entries++;
                  return value.apply(object, values);
                };
              return typeof value === 'function' ? value.bind(object) : value;
            },
          }),
        ),
      ctx,
    );
  harness.inspect = (...args) => {
    reads.inspections++;
    return inspect(...args);
  };
  return harness;
};
let release;
const gate = config.hold
  ? new Promise((resolve) => {
      release = resolve;
    })
  : Promise.resolve();
const original = faux.provider.streamSimple.bind(faux.provider);
let invocations = 0;
const progress = Promise.withResolvers();
const advance = (message) => {
  if (message?.type === 'next-chunk') progress.resolve();
};
process.on('message', advance);
faux.provider.streamSimple = (...args) => {
  if (++invocations !== 1) return original(...args);
  const stream = createAssistantMessageEventStream();
  let stopped = false;
  args[2]?.signal?.addEventListener(
    'abort',
    () => {
      stopped = true;
      progress.resolve();
      stream.end(fauxAssistantMessage('partial', { stopReason: 'aborted' }));
    },
    { once: true },
  );
  void (async () => {
    for (let i = 0; i < 5 && !stopped; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const text = 'first remote text ' + i;
      stream.push({
        type: 'text_delta',
        contentIndex: 1,
        delta: text,
        partial: fauxAssistantMessage([
          { type: 'thinking', thinking: 'remote thinking ' + i },
          { type: 'text', text },
        ]),
      });
      if (i === 0) await progress.promise;
    }
    if (stopped) return;
    await gate;
    if (!stopped) {
      const message = fauxAssistantMessage('REMOTE COMPLETED');
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end(message);
    }
  })();
  return stream;
};
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
  () => ({ calls: invocations, tools: 0, reads: { ...reads } }),
  () => {
    release?.();
    progress.resolve();
  },
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
  process.off('message', advance);
  if (process.connected) process.disconnect();
}
