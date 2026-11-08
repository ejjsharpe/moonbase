import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Effect, ManagedRuntime } from 'effect';
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { createRegistry } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { makeChatClient } from '@moonbase/application/runtime/clients';
import { releaseResource } from '@moonbase/effect';

import { PiRuntimeLive } from './index.ts';
import { closeClaudeCodeProcesses, createClaudeCodeSubscription } from './claude-code.ts';
import { serveChat } from './server.ts';
import * as V from './validation.ts';
import * as P from './protocol.ts';
import * as S from './private-schema.ts';

/** Standalone process composition root; feature services never create runtimes. */
async function main() {
  if (process.argv.length !== 3 || !isAbsolute(process.argv[2]))
    V.fail('InvalidInput', 'Supply an absolute private host configuration file.');
  const bytes = await readFile(process.argv[2]);
  if (bytes.length > 64 * 1024) V.fail('InvalidInput', 'Host configuration exceeds its bound.');
  const data = S.cliConfiguration(P.json(bytes));
  const session = { host: data.host, actorId: data.actorId };
  // Every chat here shares this cwd, and Claude Code runs (and tells the model it runs) in this
  // process's own working directory, which the library has no option to change.
  try {
    process.chdir(data.cwd);
  } catch {
    V.fail('InvalidInput', 'Chat working directory must exist.');
  }
  const models = createModels();
  models.setProvider(openaiProvider());
  models.setProvider(anthropicProvider());
  models.setProvider(createClaudeCodeSubscription());
  const selected = data.model,
    configured = models.getModel(selected.provider, selected.modelId);
  // Claude Code resolves without a stored key, so its check is what proves a host-side login.
  if (
    !configured ||
    !(await models.getAuth(configured)) ||
    !(await models.checkAuth(selected.provider))
  )
    V.fail(
      'Unavailable',
      'Configure an installed model and existing host-side provider credentials.',
    );
  const registry = createRegistry();
  registry.install(CodingTools);
  const config = {
    ...session,
    cwd: data.cwd,
    databasePath: data.databasePath,
    model: selected,
    models,
    registry,
  };
  const token = data.token,
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
    await closeClaudeCodeProcesses();
  }
}
await main().catch((error) => {
  console.error(JSON.stringify({ event: 'failed', error: P.publicError(error) }));
  process.exitCode = 1;
});
