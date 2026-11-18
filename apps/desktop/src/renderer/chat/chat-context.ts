import { createContext, useContext, useMemo } from 'react';
import { Context, type Effect } from 'effect';
import {
  ChatConfig,
  getChatAtoms,
  type ChatAtoms,
  type ChatServices,
} from '@moonbase/application/chat';
import type { DesktopRunner } from '../shell/desktop-application.ts';

/**
 * The open chat as its views share it: its services, the atoms they read its state from, and the
 * renderer root's runners. It holds no state; views subscribe to the atoms.
 */
export type ChatShared = {
  services: Context.Context<ChatServices>;
  atoms: ChatAtoms;
  /** The backend serving the chat, which names its views. */
  backendId: string;
  runner: DesktopRunner;
  /** Runs one of the chat's actions; each shows its own failure in the chat, so none rejects. */
  act(action: Effect.Effect<unknown, unknown>): Promise<void>;
};

/** Runs a chat action on the root runtime: it shows its own failure, so a rejection is dropped. */
export const runChatAction = (runner: DesktopRunner, action: Effect.Effect<unknown, unknown>) =>
  runner.run(action).then(
    () => {},
    () => {},
  );

export function makeChatShared(
  services: Context.Context<ChatServices>,
  runner: DesktopRunner,
): ChatShared {
  return {
    services,
    atoms: getChatAtoms(services),
    backendId: Context.get(services, ChatConfig).backendId,
    runner,
    act: (action) => runChatAction(runner, action),
  };
}

/** `makeChatShared`, kept while the chat and runners are the same. */
export const useChatShared = (services: Context.Context<ChatServices>, runner: DesktopRunner) =>
  useMemo(() => makeChatShared(services, runner), [services, runner]);

export const ChatContext = createContext<ChatShared | null>(null);

/** The chat the view is in. */
export const useChat = () => useContext(ChatContext)!;
