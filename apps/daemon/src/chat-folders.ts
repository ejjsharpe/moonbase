import type { ChatFolders } from '@moonbase/workspace';
import type { ChatClient } from '@moonbase/contracts/chat';
import type { DaemonClient } from '@moonbase/contracts/daemon';

/**
 * A local-mode daemon's chats as its workspace sees them, for Turn into project. The folder is the
 * chat's own working folder, which `checkChatFolder` accepts only as a direct child of the chats
 * folder, where the daemon makes folders for chats without a project; any other is refused,
 * whatever a client names. A chat already turned keeps its folder there, so turning it again
 * reopens the same checkout.
 */
export function createChatFolders(chat: ChatClient, daemon: DaemonClient): ChatFolders {
  return {
    async findOwnFolder(target) {
      const { conversation } = await chat.command('getChat', { target });
      await daemon.command('checkChatFolder', { host: target.host, path: conversation.cwd });
      return conversation.cwd;
    },
    async markAsProject(requestId, target) {
      await daemon.command('markFolderAsProject', { requestId, target });
    },
  };
}
