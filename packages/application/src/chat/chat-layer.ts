import { Layer } from 'effect';
import type { ChatDependencies } from './chat-ports.ts';
import { ChatConfig } from './chat-config.ts';
import { ChatActions } from './actions/actions-service.ts';
import { ChatDrafts } from './drafts/drafts-service.ts';
import { ChatLink } from './link/link-service.ts';
import { ChatSelection } from './selection/selection-service.ts';
import { ChatList } from './chat-list/chat-list-service.ts';
import { ChatSends } from './sends/sends-service.ts';
import { ChatProviderSetup } from './provider-setup/provider-setup-service.ts';
import { ChatConnection } from './connection/connection-service.ts';
import { ChatFileSearch } from './file-search/file-search-service.ts';

/** Every service of one chat target's chat. */
export type ChatServices =
  | ChatConfig
  | ChatActions
  | ChatDrafts
  | ChatLink
  | ChatSelection
  | ChatList
  | ChatSends
  | ChatProviderSetup
  | ChatConnection
  | ChatFileSearch;

/**
 * One chat target's chat over `dependencies`: build it in a scope, and closing the scope stops
 * admissions, interrupts the chat's work and cancels a running sign-in.
 */
export const chatLayer = (dependencies: ChatDependencies): Layer.Layer<ChatServices> => {
  const base = Layer.provideMerge(ChatActions.layer, ChatConfig.layer(dependencies));
  const stored = Layer.provideMerge(Layer.merge(ChatDrafts.layer, ChatLink.layer), base);
  const selection = Layer.provideMerge(ChatSelection.layer, stored);
  const list = Layer.provideMerge(ChatList.layer, selection);
  const sends = Layer.provideMerge(
    Layer.mergeAll(ChatSends.layer, ChatProviderSetup.layer, ChatFileSearch.layer),
    list,
  );
  return Layer.provideMerge(ChatConnection.layer, sends);
};
