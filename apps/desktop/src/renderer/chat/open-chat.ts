import { findSelectedChat, type ChatState } from '@moonbase/application/chat';
import type { DesktopChat } from './desktop-chat.ts';

/** Whether the controller is running the action named `id` (`send`, `stop`, `settle`…). */
export const isBusy = (state: Pick<ChatState, 'active'>, id: string) => state.active.includes(id);

/** Whether the open chat is settled, or null while it can't be settled or unsettled. */
export function readOpenSettled(state: ChatState) {
  const chat = findSelectedChat(state);
  return state.selected && chat && state.ready && !isBusy(state, 'settle')
    ? chat.settledAt !== undefined
    : null;
}

/** Settles or unsettles the open chat. */
export function settleOpenChat(controller: DesktopChat, state: ChatState, settled: boolean) {
  if (state.selected) void controller.settle(state.selected, settled);
}

/** The open chat's title, and its folder and model for the title's hover text. */
export function describeOpenChat(state: ChatState) {
  let title = 'New chat';
  if (state.selected) title = 'Saved chat selected';
  if (state.snapshot) title = state.snapshot.conversation.title;
  const context = state.snapshot
    ? `${state.snapshot.conversation.cwd} · ${state.snapshot.conversation.model}`
    : 'Each conversation retains its working folder and model.';
  return { title, context };
}

/** Focuses the composer's message. */
export const focusMessage = () => document.getElementById('message')?.focus();

/** Focuses the composer's message with the caret at its end, once it has drawn. */
export const focusMessageEnd = () =>
  requestAnimationFrame(() => {
    const input = document.getElementById('message');
    if (!(input instanceof HTMLTextAreaElement)) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
