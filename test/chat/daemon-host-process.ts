// The controlled remote host: the real daemon in host mode, run on Bun by `controlled-host-fixture.ts` over IPC. A
// behaviour module (`faux-*.mjs`) supplies its faux providers and tools; `host-control.ts` counts
// and holds requests through the daemon's chat client. No provider or network is reached.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MutableModels } from '@earendil-works/pi-ai/models';
import type { ChatServiceShape } from '@moonbase/contracts/services';
import type { LocalPiRuntimeConfiguration } from '@moonbase/chat-runtime';
import { makeKeyFileSource } from '@moonbase/chat-runtime/credentials';
import { Cause, Effect } from 'effect';
import { runDaemon } from '../../apps/daemon/src/daemon.ts';
import { argumentsConfig } from '../../apps/daemon/src/daemon-config.ts';
import { runDaemonProcess } from '../../apps/daemon/src/daemon-process.ts';
import { hostControl } from './host-control.ts';

type Behaviour = {
  installProviders(models: MutableModels): void;
  registry?: LocalPiRuntimeConfiguration['registry'];
  stats(): Record<string, unknown>;
  release(): void;
  close?(): void;
};

const args = process.argv.slice(2);
const fixture = JSON.parse(readFileSync(join(args[0]!, 'fixture.json'), 'utf8')) as {
  behaviour: string;
  hold: boolean;
};
const { createBehaviour } = (await import(fixture.behaviour)) as {
  createBehaviour(options: { hold: boolean }): Behaviour;
};
const behaviour = createBehaviour({ hold: fixture.hold });
// The test's shutdown, or its process going away, stops the daemon cleanly, as SIGTERM does.
const ended = Promise.withResolvers<void>();
let control: ReturnType<typeof hostControl> | undefined;
const daemon = runDaemon({
  ready: (line) =>
    Effect.sync(() => void process.send?.({ event: 'ready', port: JSON.parse(line).port })),
  closeClaudeCode: Effect.void,
  providers: (settings) => ({
    keySource: makeKeyFileSource(
      settings.credentialKey?.source === 'file' ? settings.credentialKey.path : '',
    ),
    installProviders: (models) => {
      behaviour.installProviders(models);
      return undefined;
    },
    ...(behaviour.registry ? { registry: behaviour.registry } : {}),
  }),
  wrapChat: (chat: ChatServiceShape) => {
    control = hostControl(chat, behaviour.stats, behaviour.release);
    void control.ended.then(() => ended.resolve());
    return control.bound;
  },
}).pipe(
  Effect.raceFirst(
    Effect.as(
      Effect.promise(() => ended.promise),
      'stopped' as const,
    ),
  ),
  Effect.tapCause((cause) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.void
      : Effect.sync(() => void process.send?.({ event: 'failed' })),
  ),
  Effect.ensuring(
    Effect.sync(() => {
      control?.close();
      behaviour.close?.();
      if (process.connected) process.disconnect?.();
    }),
  ),
);
runDaemonProcess(daemon, argumentsConfig(args));
