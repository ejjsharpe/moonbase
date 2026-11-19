import { Context, Effect, Stream } from 'effect';
import { ChatDrafts } from '../drafts/drafts-service.ts';
import { ChatSelection } from '../selection/selection-service.ts';
import { ChatSends } from '../sends/sends-service.ts';
import type { ChatServices } from '../chat-layer.ts';
import { readChatState, watchChatState } from '../chat-state.ts';
import type { ComposerChat } from './composer-service.ts';

/** What a composer uses of a chat, from its services. */
export function makeComposerChat(context: Context.Context<ChatServices>): ComposerChat {
  const drafts = Context.get(context, ChatDrafts);
  const selection = Context.get(context, ChatSelection);
  const sends = Context.get(context, ChatSends);
  return {
    state: Effect.provideContext(readChatState, context),
    changes: Stream.provideContext(watchChatState, context),
    setDraft: drafts.setDraft,
    moveToNewChat: drafts.moveToNewChat,
    send: sends.send,
    closeView: selection.closeView,
    select: selection.select,
  };
}
