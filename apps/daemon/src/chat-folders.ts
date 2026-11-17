import { Effect } from 'effect';
import type { ChatFolders } from '@moonbase/workspace';
import type { ChatServiceShape, LocalHostHandlers } from '@moonbase/contracts/services';

/**
 * A local-mode daemon's chats as its workspace sees them, for Turn into project. The folder is the
 * chat's own working folder, which `checkChatFolder` accepts only as a direct child of the chats
 * folder, where the daemon makes folders for chats without a project; any other is refused,
 * whatever a client names. A chat already turned keeps its folder there, so turning it again
 * reopens the same checkout. A refusal or failure fails with the chat or folder error as it is,
 * which the workspace passes on.
 */
export const makeChatFolders = (
  chat: ChatServiceShape,
  localHost: LocalHostHandlers,
): ChatFolders => ({
  findOwnFolder: (target) =>
    Effect.gen(function* () {
      const { conversation } = yield* chat.getChat({ target });
      yield* localHost.checkChatFolder({ host: target.host, path: conversation.cwd });
      return conversation.cwd;
    }),
  markAsProject: (requestId, target) =>
    Effect.asVoid(localHost.markFolderAsProject({ requestId, target })),
});
