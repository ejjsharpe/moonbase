import type { ComponentProps } from 'react';
import type { MoonbaseApplicationSnapshot } from '@moonbase/application';
import { ChatView } from '../chat/chat-view.tsx';
import type { SettingsSection } from './settings.tsx';
import { ChatUnavailable } from './shell-notices.tsx';

type ChatViewProps = ComponentProps<typeof ChatView>;

/** Agents' chat: the chat list and open chat, or why chat is unavailable. */
export function AgentsChat({
  chat,
  lifecycle,
  shown,
  selectTarget,
  openSettings,
}: {
  /** The chat view's props, null while no chat is open; their target names the view. */
  chat: Omit<ChatViewProps, 'hosts' | 'setUpProviders'> | null;
  lifecycle: MoonbaseApplicationSnapshot;
  /** Whether Agents shows the chat, rather than the project dock. */
  shown: boolean;
  selectTarget(id: string): void;
  openSettings(section: SettingsSection): void;
}) {
  if (!chat)
    return <ChatUnavailable lifecycle={lifecycle} chooseHost={() => openSettings('hosts')} />;
  if (!shown) return null;
  return (
    <ChatView
      key={lifecycle.chatTargetId}
      {...chat}
      hosts={
        lifecycle.chatTargets.length
          ? {
              targets: lifecycle.chatTargets,
              current: lifecycle.chatTargetId,
              select: selectTarget,
              disabled: lifecycle.phase !== 'live' || lifecycle.chat.state === 'opening',
            }
          : undefined
      }
      setUpProviders={chat.controller.providers ? () => openSettings('providers') : undefined}
    />
  );
}
