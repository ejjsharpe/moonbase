// Controlled authenticated remote image fixture; public runtime APIs, temporary SQLite only.
import { readFileSync } from 'node:fs';
import { Effect } from 'effect';
import { serveChat } from '@moonbase/pi-runtime/server';
import { hostControl } from '../../../tests/chat/host-control.mjs';
import { createImageRuntime } from './stored-image-fixture.ts';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { runtime, client } = createImageRuntime({
  ...config.session,
  cwd: config.cwd,
  databasePath: config.databasePath,
});
const { bound, ended, close } = hostControl(
  client,
  () => ({ calls: 0, tools: 0 }),
  () => {},
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
