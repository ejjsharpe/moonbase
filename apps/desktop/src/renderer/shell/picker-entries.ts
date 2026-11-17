import type { ChatSummary } from '@moonbase/contracts/chat';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { checkoutName } from '@moonbase/ui/projects';
import type { PickerEntry } from '@moonbase/workbench';
import { formatChatAge } from '../chat/age.ts';
import { getChatPlace } from '../chat/folder.ts';
import { homePath } from '../components/folder-menu.tsx';

/**
 * The picker's chats, projects and app commands; the workbench adds files and editor commands.
 * Each command is present only when it can run.
 */
export function makePickerEntries({
  chats,
  checkouts,
  showChat,
  showCheckout,
  startNewChat,
  dock,
  showAgents,
  openProject,
}: {
  chats: readonly ChatSummary[];
  checkouts: readonly CheckoutTarget[];
  showChat?: (chat: ChatSummary) => void;
  showCheckout(checkout: CheckoutTarget): void;
  startNewChat?: () => void;
  /** Whether project chats show, and showing or hiding them, while a project is in view. */
  dock?: { open: boolean; toggle(): void };
  showAgents?: () => void;
  openProject?: () => void;
}): PickerEntry[] {
  return [
    ...(showChat
      ? chats.map((summary, index) => ({
          id: summary.target.conversationId,
          kind: 'chat' as const,
          label: summary.title,
          detail: `${getChatPlace(summary)} · ${formatChatAge(summary.activity?.at ?? summary.createdAt)}`,
          recent: index < 3,
          run: () => showChat(summary),
        }))
      : []),
    ...checkouts.map((checkout) => ({
      id: checkout.checkoutId,
      kind: 'project' as const,
      label: checkoutName(checkout),
      detail: checkout.vcs === 'git' ? '⎇ ' + checkout.branch : homePath(checkout.root),
      projectId: checkout.projectId,
      run: () => showCheckout(checkout),
    })),
    ...(startNewChat
      ? [
          {
            id: 'new-chat',
            kind: 'command' as const,
            label: 'New chat',
            shortcut: '⌘N',
            run: startNewChat,
          },
        ]
      : []),
    ...(dock
      ? [
          {
            id: 'toggle-dock',
            kind: 'command' as const,
            label: dock.open ? 'Hide project chats' : 'Show project chats',
            shortcut: '⌘J',
            run: dock.toggle,
          },
        ]
      : []),
    ...(showAgents
      ? [{ id: 'show-agents', kind: 'command' as const, label: 'Go to Agents', run: showAgents }]
      : []),
    ...(openProject
      ? [{ id: 'open-project', kind: 'command' as const, label: 'Open project…', run: openProject }]
      : []),
  ];
}
