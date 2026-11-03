import { createRegistry } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { Context, Effect, Layer } from 'effect';
import type { ApplicationError } from '@moonbase/contracts/workspace';
import { ChatService, type ChatServiceShape } from '@moonbase/contracts/services';
import { type Host, safeError } from './commands.ts';
import { openHost } from './resources.ts';
import type { PiRuntimeConfiguration, LocalPiRuntimeConfiguration } from './runtime-types.ts';

export type { PiRuntimeConfiguration, LocalPiRuntimeConfiguration } from './runtime-types.ts';

/** Privileged shutdown control; it grants no renderer capability. */
export class LocalPiControl extends Context.Service<
  LocalPiControl,
  {
    setAdmissionsOpen(open: boolean): void;
    hasActiveWork(): Effect.Effect<boolean, ApplicationError>;
  }
>()('moonbase/LocalPiControl') {}
function makeChatService(host: Host): ChatServiceShape {
  return {
    getChatHost: (d) => host.run('getChatHost', d, (input) => host.getHost(input)),
    listChats: (d) => host.run('listChats', d, (input) => host.list(input)),
    createChat: (d) => host.run('createChat', d, (input) => host.create(input)),
    getChat: (d) => host.run('getChat', d, (input) => host.snapshot(input.target)),
    getChatHistory: (d) => host.run('getChatHistory', d, (input) => host.getHistory(input)),
    sendChat: (d) => host.run('sendChat', d, (input) => host.send(input)),
    getChatSend: (d) => host.run('getChatSend', d, (input) => host.getSend(input)),
    stopChat: (d) => host.run('stopChat', d, (input) => host.stop(input)),
    watch: ({ target }) => host.watch(target),
  };
}
export const PiRuntimeLive = (
  config: PiRuntimeConfiguration,
): Layer.Layer<ChatService, ApplicationError> =>
  Layer.effect(
    ChatService,
    Effect.gen(function* () {
      const host = yield* openHost(config);
      return makeChatService(host);
    }),
  );

export const LocalPiRuntimeLive = (
  config: LocalPiRuntimeConfiguration,
): Layer.Layer<ChatService | LocalPiControl, ApplicationError> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const registry = config.registry ?? createRegistry();
      if (!config.registry) registry.install(CodingTools);
      const host = yield* openHost({ ...config, registry, mode: 'local' });
      return Context.make(ChatService, makeChatService(host)).pipe(
        Context.add(LocalPiControl, {
          setAdmissionsOpen: (open) => {
            host.admissionsOpen = open;
          },
          hasActiveWork: () =>
            Effect.tryPromise({ try: () => host.hasActiveWork(), catch: safeError }),
        }),
      );
    }),
  );
