import { normalizeApplicationError } from '@moonbase/effect';
import { createRegistry } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { Context, Effect, Layer, Stream } from 'effect';
import type { ApplicationError } from '@moonbase/contracts/workspace';
import { ChatService, type ChatServiceShape } from '@moonbase/contracts/services';
import { type Host, safeError } from './commands.ts';
import { watchChatListState } from './chat-list.ts';
import { ClaudeCodeWorkingDirectory } from './claude-code-working-directory.ts';
import { LocalPiControl } from './local-pi-control.ts';
import { openHost } from './resources.ts';
import type { LocalPiRuntimeConfiguration } from './runtime-types.ts';

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
    watchChatList: ({ session }) =>
      Stream.unwrap(
        Effect.map(
          Effect.try({ try: () => host.session(session), catch: normalizeApplicationError }),
          () => watchChatListState(host, session),
        ),
      ),
  };
}
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
      const host = yield* openHost({ ...config, registry });
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
