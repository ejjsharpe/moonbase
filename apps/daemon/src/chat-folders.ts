import type { ChatFolders } from '@moonbase/workspace';
import { Effect } from 'effect';
import { toChatApplicationError } from '@moonbase/contracts/chat-legacy-errors';
import type {
  ChatServiceShape,
  LocalHostHandlers,
  LocalHostServiceError,
} from '@moonbase/contracts/services';

/**
 * A local-mode daemon's chats as its workspace sees them, for Turn into project. The folder is the
 * chat's own working folder, which `checkChatFolder` accepts only as a direct child of the chats
 * folder, where the daemon makes folders for chats without a project; any other is refused,
 * whatever a client names. A chat already turned keeps its folder there, so turning it again
 * reopens the same checkout. The workspace reads a refusal as the legacy error with its code, until
 * it moves off `ApplicationError` (CL-07).
 */
export function createChatFolders(
  chat: ChatServiceShape,
  localHost: LocalHostHandlers,
  runEffect: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
): ChatFolders {
  const run = <A>(effect: Effect.Effect<A, LocalHostServiceError>) =>
    runEffect(effect.pipe(Effect.mapError(toChatApplicationError)));
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
