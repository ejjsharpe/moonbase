import type { ChatSummary } from '@moonbase/contracts/chat';

/** A folder's last path segment, as the chat list names it. */
export const getFolderName = (path: string) => path.split('/').filter(Boolean).at(-1) || '/';
/** Where a chat runs, as the UI names it: its folder, or "No project" for a folder of its own. */
export const getChatPlace = (chat: Pick<ChatSummary, 'cwd' | 'ownFolder'>) =>
  chat.ownFolder ? 'No project' : getFolderName(chat.cwd);
