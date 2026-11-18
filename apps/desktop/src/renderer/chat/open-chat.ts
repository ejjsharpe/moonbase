import type { ChatSnapshot, ChatTarget } from '@moonbase/contracts/chat';

/** Whether the chat is running the action named `id` (`send`, `stop`, `settle`…). */
export const isBusy = (active: readonly string[], id: string) => active.includes(id);

/** Whether the open chat is settled, or null while it can't be settled or unsettled. */
export function readOpenSettled(open: {
  selected: ChatTarget | null;
  chat: { settledAt?: string } | undefined;
  ready: boolean;
  active: readonly string[];
}) {
  return open.selected && open.chat && open.ready && !isBusy(open.active, 'settle')
    ? open.chat.settledAt !== undefined
    : null;
}

/** The open chat's title, and its folder and model for the title's hover text. */
export function describeOpenChat(open: {
  selected: ChatTarget | null;
  snapshot: ChatSnapshot | null;
}) {
  let title = 'New chat';
  if (open.selected) title = 'Saved chat selected';
  if (open.snapshot) title = open.snapshot.conversation.title;
  const context = open.snapshot
    ? `${open.snapshot.conversation.cwd} · ${open.snapshot.conversation.model}`
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
