import { useAtomValue } from '@effect/atom-react';
import { findSelectedChat } from '@moonbase/application/chat';
import { useChat } from './chat-context.ts';
import { readOpenSettled } from './open-chat.ts';

/**
 * The open chat as its header and composer show it: its target, snapshot and listing, whether the
 * host is ready, the actions running, and whether it is settled (null while that can't change).
 */
export function useOpenChat() {
  const { atoms } = useChat();
  const selected = useAtomValue(atoms.selected);
  const snapshot = useAtomValue(atoms.snapshot);
  const { chats } = useAtomValue(atoms.list);
  const ready = useAtomValue(atoms.ready);
  const active = useAtomValue(atoms.active);
  const chat = findSelectedChat({ selected, snapshot, chats });
  return {
    selected,
    snapshot,
    chat,
    ready,
    active,
    settled: readOpenSettled({ selected, chat, ready, active }),
  };
}
