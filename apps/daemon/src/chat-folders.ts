import type { ChatFolders } from '@moonbase/workspace';
import type { Effect } from 'effect';
import type { ApplicationError } from '@moonbase/contracts/errors';
import type { ChatServiceShape, LocalHostHandlers } from '@moonbase/contracts/services';

/**
 * A local-mode daemon's chats as its workspace sees them, for Turn into project. The folder is the
 * chat's own working folder, which `checkChatFolder` accepts only as a direct child of the chats
 * folder, where the daemon makes folders for chats without a project; any other is refused,
 * whatever a client names. A chat already turned keeps its folder there, so turning it again
 * reopens the same checkout.
 */
export function createChatFolders(
  chat: ChatServiceShape,
  localHost: LocalHostHandlers,
  run: <A>(effect: Effect.Effect<A, ApplicationError>) => Promise<A>,
): ChatFolders {
  return {
    async findOwnFolder(target) {
      const { conversation } = await run(chat.getChat({ target }));
      await run(localHost.checkChatFolder({ host: target.host, path: conversation.cwd }));
      return conversation.cwd;
    },
    async markAsProject(requestId, target) {
      await run(localHost.markFolderAsProject({ requestId, target }));
    },
  };
}
