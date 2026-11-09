import { createRegistry, defineExtension, section } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { Context, Effect, Layer } from 'effect';
import type { ApplicationError } from '@moonbase/contracts/workspace';
import type { ChatTarget } from '@moonbase/contracts/chat';
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
    /** Clears `ownFolder` once a chat's own folder has become a project where it is. */
    markFolderAsProject(target: ChatTarget): Effect.Effect<void, ApplicationError>;
  }
>()('moonbase/LocalPiControl') {}
function makeChatService(host: Host): ChatServiceShape {
  return {
    getChatHost: (d) => host.run('getChatHost', d, (input) => host.getHost(input)),
    listChats: (d) => host.run('listChats', d, (input) => host.list(input)),
    createChat: (d) => host.run('createChat', d, (input) => host.create(input)),
    getChat: (d) => host.run('getChat', d, (input) => host.snapshot(input.target)),
    getChatHistory: (d) => host.run('getChatHistory', d, (input) => host.getHistory(input)),
    getChatTranscriptContent: (d) =>
      host.run('getChatTranscriptContent', d, (input) => host.getTranscriptContent(input)),
    findChatTranscript: (d) =>
      host.run('findChatTranscript', d, (input) => host.findTranscript(input)),
    getChatHistoryAround: (d) =>
      host.run('getChatHistoryAround', d, (input) => host.getHistoryAround(input)),
    sendChat: (d) => host.run('sendChat', d, (input) => host.send(input)),
    getChatSend: (d) => host.run('getChatSend', d, (input) => host.getSend(input)),
    stopChat: (d) => host.run('stopChat', d, (input) => host.stop(input)),
    settleChat: (d) => host.run('settleChat', d, (input) => host.settle(input)),
    findChatFiles: (d) => host.run('findChatFiles', d, (input) => host.findFiles(input)),
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

/**
 * Claude Code runs in this process's working directory and tells the model so, but its library
 * offers no way to give it a chat's own; until it does, state the chat's to the model.
 */
const ClaudeCodeWorkingDirectory = defineExtension({
  name: 'moonbase-claude-code-cwd',
  sections: [
    section('working-directory', ({ agent }) =>
      agent.model?.provider === 'claude-code' && agent.cwd
        ? `The working directory is ${agent.cwd}, and tools resolve relative paths against it. Use it instead of any other working directory you are told.`
        : undefined,
    ),
  ],
});

export const LocalPiRuntimeLive = (
  config: LocalPiRuntimeConfiguration,
): Layer.Layer<ChatService | LocalPiControl, ApplicationError> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const registry = config.registry ?? createRegistry();
      if (!config.registry) {
        registry.install(CodingTools);
        registry.install(ClaudeCodeWorkingDirectory);
      }
      const host = yield* openHost({ ...config, registry, mode: 'local' });
      return Context.make(ChatService, makeChatService(host)).pipe(
        Context.add(LocalPiControl, {
          setAdmissionsOpen: (open) => {
            host.admissionsOpen = open;
          },
          hasActiveWork: () =>
            Effect.tryPromise({ try: () => host.hasActiveWork(), catch: safeError }),
          markFolderAsProject: (target) =>
            Effect.tryPromise({
              try: () => host.markFolderAsProject(target),
              catch: (error) => safeError(error, true),
            }),
        }),
      );
    }),
  );
