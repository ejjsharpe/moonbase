import type { ChatSummary } from '@moonbase/contracts/chat';
import { folderName } from '../components/folder-menu.tsx';

/** Where a chat runs, as the UI names it: its folder, or "No project" for a folder of its own. */
export const getChatPlace = (chat: Pick<ChatSummary, 'cwd' | 'ownFolder'>) =>
  chat.ownFolder ? 'No project' : folderName(chat.cwd);
