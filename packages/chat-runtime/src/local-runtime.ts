import { createRegistry } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { Context, Effect, Layer, Stream } from 'effect';
import type { ChildProcessSpawner } from 'effect/process';
import type { ChatError } from '@moonbase/contracts/chat-errors';
import { ChatService, type ChatServiceShape } from '@moonbase/contracts/services';
import { markFolderAsProject, settleChat } from './commands/chat-metadata.ts';
import type { Host } from './commands/chat-host.ts';
import {
  findFiles,
  findInTranscript,
  getChatHost,
  getHistory,
  getHistoryAround,
  getTranscriptContent,
  listChats,
  readSnapshot,
} from './commands/chat-reads.ts';
import { createChat } from './commands/create-chat.ts';
import { getSend, sendChat } from './commands/send-chat.ts';
import { stopChat } from './commands/stop-chat.ts';
import { watchChat } from './commands/watch-chat.ts';
import { watchChatListState } from './chat-list/watch-chat-list.ts';
import { ClaudeCodeWorkingDirectory } from './claude-code-working-directory.ts';
import { LocalPiControl } from './local-pi-control.ts';
import { openHost } from './resources.ts';
import type { LocalPiRuntimeConfiguration } from './runtime-types.ts';

function makeChatService(host: Host): ChatServiceShape {
  return {
    getChatHost: (d) => host.run('getChatHost', d, (input) => getChatHost(host, input)),
    listChats: (d) => host.run('listChats', d, (input) => listChats(host, input)),
    createChat: (d) => host.run('createChat', d, (input) => createChat(host, input)),
    getChat: (d) => host.run('getChat', d, (input) => readSnapshot(host, input.target)),
    getChatHistory: (d) => host.run('getChatHistory', d, (input) => getHistory(host, input)),
    getChatTranscriptContent: (d) =>
      host.run('getChatTranscriptContent', d, (input) => getTranscriptContent(host, input)),
    findChatTranscript: (d) =>
      host.run('findChatTranscript', d, (input) => findInTranscript(host, input)),
    getChatHistoryAround: (d) =>
      host.run('getChatHistoryAround', d, (input) => getHistoryAround(host, input)),
    sendChat: (d) => host.run('sendChat', d, (input) => sendChat(host, input)),
    getChatSend: (d) => host.run('getChatSend', d, (input) => getSend(host, input)),
    stopChat: (d) => host.run('stopChat', d, (input) => stopChat(host, input)),
    settleChat: (d) => host.run('settleChat', d, (input) => settleChat(host, input)),
    findChatFiles: (d) => host.run('findChatFiles', d, (input) => findFiles(host, input)),
    watch: ({ target }) => watchChat(host, target),
    watchChatList: ({ session }) =>
      Stream.unwrap(Effect.as(host.checkSession(session), watchChatListState(host, session))),
  };
}
/**
 * The chat runtime on one Pi store. It needs a `ChildProcessSpawner` for the file search's checks;
 * the process root provides the platform's.
 */
export const LocalPiRuntimeLive = (
  config: LocalPiRuntimeConfiguration,
): Layer.Layer<ChatService | LocalPiControl, ChatError, ChildProcessSpawner.ChildProcessSpawner> =>
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
          setAdmissionsOpen: (open) => host.setAdmissionsOpen(open),
          hasActiveWork: () => host.hasActiveWork(),
          markFolderAsProject: (target) => markFolderAsProject(host, target),
        }),
      );
    }),
  );
