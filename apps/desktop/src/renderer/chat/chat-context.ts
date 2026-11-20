import { createContext, useContext, useMemo } from 'react';
import { Context, type Effect } from 'effect';
import {
  ChatConfig,
  getChatAtoms,
  type ChatAtoms,
  type ChatServices,
} from '@moonbase/application/chat';
import { useRun } from '../hooks/use-run.ts';

/**
 * The open chat as its views share it: its services, the atoms they read its state from, and how
 * they run its actions. It holds no state; views subscribe to the atoms.
 */
export type ChatShared = {
  services: Context.Context<ChatServices>;
  atoms: ChatAtoms;
  /** The backend serving the chat, which names its views. */
  backendId: string;
  /**
   * Runs one of the chat's actions for as long as the view sharing it shows; each shows its own
   * failure in the chat.
   */
  act(action: Effect.Effect<unknown, unknown>): void;
};

/** The chat shared with the views under the calling one, whose unmounting ends what they run. */
export function useChatShared(services: Context.Context<ChatServices>): ChatShared;
export function useChatShared(services: Context.Context<ChatServices> | null): ChatShared | null;
export function useChatShared(services: Context.Context<ChatServices> | null): ChatShared | null {
  const act = useRun();
  return useMemo(
    () =>
      services && {
        services,
        atoms: getChatAtoms(services),
        backendId: Context.get(services, ChatConfig).backendId,
        act,
      },
    [services, act],
  );
}

export const ChatContext = createContext<ChatShared | null>(null);

/** The chat the view is in. */
export const useChat = () => useContext(ChatContext)!;
