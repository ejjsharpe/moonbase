// The controlled remote host: the real daemon in host mode, run on Bun by `controlled-host-fixture.ts` over IPC. A
// behaviour module (`faux-*.mjs`) supplies its faux providers and tools; `host-control.ts` counts
// and holds requests through the daemon's chat client. No provider or network is reached.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MutableModels } from '@earendil-works/pi-ai/models';
import type { ChatClient } from '@moonbase/contracts/chat';
import type { LocalPiRuntimeConfiguration } from '@moonbase/chat-runtime';
import { createKeyFileSource } from '@moonbase/chat-runtime/credentials';
import { runDaemon } from '../../apps/daemon/src/daemon.ts';
import { readDirectoryArgument } from '../../apps/daemon/src/data-directory.ts';
import { hostControl } from './host-control.ts';

type Behaviour = {
  installProviders(models: MutableModels): void;
  registry?: LocalPiRuntimeConfiguration['registry'];
  stats(): Record<string, unknown>;
  release(): void;
  close?(): void;
};

const directory = readDirectoryArgument(process.argv.slice(2));
const fixture = JSON.parse(readFileSync(join(directory, 'fixture.json'), 'utf8')) as {
  behaviour: string;
  hold: boolean;
};
const { createBehaviour } = (await import(fixture.behaviour)) as {
  createBehaviour(options: { hold: boolean }): Behaviour;
};
const behaviour = createBehaviour({ hold: fixture.hold });
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
let control: ReturnType<typeof hostControl> | undefined;
try {
  await runDaemon({
    directory,
    signal: controller.signal,
    ready: (line) => process.send?.({ event: 'ready', port: JSON.parse(line).port }),
    closeClaudeCode: async () => {},
    providers: (settings) => ({
      keySource: createKeyFileSource(
        settings.credentialKey?.source === 'file' ? settings.credentialKey.path : '',
      ),
      installProviders: (models) => {
        behaviour.installProviders(models);
        return undefined;
      },
      ...(behaviour.registry ? { registry: behaviour.registry } : {}),
    }),
    wrapChat: (client: ChatClient) => {
      control = hostControl(client, behaviour.stats, behaviour.release);
      // The test's shutdown, or its process going away, stops the daemon cleanly.
      void control.ended.then(() => controller.abort());
      return control.bound as ChatClient;
    },
  });
} catch {
  process.send?.({ event: 'failed' });
  process.exitCode = 1;
} finally {
  control?.close();
  behaviour.close?.();
  if (process.connected) process.disconnect?.();
}
