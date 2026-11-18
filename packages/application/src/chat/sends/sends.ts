import type {
  ChatCreationSettings,
  ChatMention,
  ChatOutput,
  ChatSession,
  ChatStopTarget,
  ChatSummary,
} from '@moonbase/contracts/chat';
import { ChatRefusedError, describeChatFailure } from '../chat-errors.ts';
import {
  countBytes,
  isBoundedText,
  isSameTarget,
  maximumDraftBytes,
  maximumDrafts,
  maximumPending,
  type Pending,
  type Saved,
} from '../drafts/drafts.ts';

// The outbox's rules (D16 pure layer). A command is reserved in the saved drafts, with its
// original identity, before it is sent, and leaves only when its outcome is known, so a lost
// reply is queried, never resent, and a retry repeats the original identity.

const refuse = (reason: ConstructorParameters<typeof ChatRefusedError>[0]['reason']) =>
  new ChatRefusedError({ reason });

const isSameStop = (a: ChatStopTarget, b: ChatStopTarget) =>
  isSameTarget(a.target, b.target) && a.submissionId === b.submissionId && a.taskId === b.taskId;

/** A new chat's title from its first message's first line, at most 80 UTF-8 bytes. */
export function titleFromMessage(text: string) {
  let title = '';
  for (const character of text.trim().split('\n')[0]!) {
    if (countBytes(title + character) > 80) break;
    title += character;
  }
  return title || 'New conversation';
}

/** A Create, retained with its identity until its outcome is known. */
export function makeCreate(
  session: ChatSession,
  requestId: string,
  title: string,
  settings: ChatCreationSettings | undefined,
): Pending | ChatRefusedError {
  if (!isBoundedText(title, 200) || !title.trim()) return refuse('title');
  if (!settings) return refuse('no-settings');
  return {
    operation: 'createChat',
    input: structuredClone({ session, requestId, title, settings }),
    message: 'Outcome pending. Original creation identity retained.',
  };
}

/**
 * The Send of the selected chat's draft, or for no selected chat the Create of a new chat whose
 * first message it is. `newId` names each request.
 */
export function makeSend(
  saved: Saved,
  draft: { text: string; mentions: readonly ChatMention[] },
  session: ChatSession,
  settings: ChatCreationSettings | undefined,
  newId: () => string,
): Pending | ChatRefusedError {
  const target = saved.selected;
  const message = {
    text: draft.text,
    ...(draft.mentions.length ? { mentions: structuredClone([...draft.mentions]) } : {}),
  };
  if (!isBoundedText(draft.text, maximumDraftBytes) || !draft.text.trim())
    return refuse('empty-message');
  if (!target) {
    if (saved.drafts.length >= maximumDrafts) return refuse('draft-limit');
    if (saved.pending.some((item) => item.operation === 'createChat' && item.firstMessage))
      return refuse('pending-create');
    if (!settings) return refuse('no-settings');
    return {
      operation: 'createChat',
      input: structuredClone({
        session,
        requestId: newId(),
        title: titleFromMessage(draft.text),
        settings,
      }),
      firstMessage: { requestId: newId(), ...message },
      message: 'Outcome pending. Original creation and first message retained.',
    };
  }
  if (isSending(saved, target)) return refuse('pending-send');
  return {
    operation: 'sendChat',
    input: { target: structuredClone(target), requestId: newId(), ...message },
    message: 'Outcome pending. Original Send identity and text retained.',
  };
}

/** Whether a Send of `target` is retained: another may not start until it is resolved. */
const isSending = (saved: Saved, target: NonNullable<Saved['selected']>) =>
  saved.pending.some(
    (item) => item.operation === 'sendChat' && isSameTarget(item.input.target, target),
  );

/** A Stop of exactly the running submission and task. */
export function makeStop(saved: Saved, stop: ChatStopTarget, requestId: string) {
  if (
    saved.pending.some((item) => item.operation === 'stopChat' && isSameStop(item.input.stop, stop))
  )
    return refuse('pending-stop');
  return {
    operation: 'stopChat',
    input: { stop: structuredClone(stop), requestId },
    message: 'Outcome pending. Exact submission/task retained.',
  } satisfies Pending;
}

/**
 * `saved` with `pending` reserved. The checks that refuse a second Send of the same chat (or a
 * second new chat, or Stop) run again here, in the step that reserves it.
 */
export function reservePending(saved: Saved, pending: Pending): Saved | ChatRefusedError {
  if (saved.pending.length >= maximumPending) return refuse('pending-limit');
  if (pending.operation === 'sendChat' && isSending(saved, pending.input.target))
    return refuse('pending-send');
  if (
    pending.operation === 'createChat' &&
    pending.firstMessage &&
    saved.pending.some((item) => item.operation === 'createChat' && item.firstMessage)
  )
    return refuse('pending-create');
  if (
    pending.operation === 'stopChat' &&
    saved.pending.some(
      (item) => item.operation === 'stopChat' && isSameStop(item.input.stop, pending.input.stop),
    )
  )
    return refuse('pending-stop');
  const next = structuredClone(saved);
  next.pending.push(structuredClone(pending));
  return next;
}

/** Whether `requestId`'s command is still retained. */
export const isPending = (saved: Saved, requestId: string) =>
  saved.pending.some((item) => item.input.requestId === requestId);

/**
 * `saved` with `pending` resolved: an admitted Send clears the draft it sent (unless edited
 * since); a created chat takes the new chat's draft, is selected, and has its first message's
 * Send (`firstSend`) reserved in the same step.
 */
export function resolvePending(
  saved: Saved,
  pending: Pending,
  conversation?: ChatSummary,
  firstSend?: Pending,
): Saved | ChatRefusedError {
  const next = structuredClone(saved);
  next.pending = next.pending.filter((item) => item.input.requestId !== pending.input.requestId);
  if (pending.operation === 'sendChat')
    next.drafts = next.drafts.filter(
      (draft) =>
        !isSameTarget(draft.target, pending.input.target) || draft.text !== pending.input.text,
    );
  if (conversation) {
    if (pending.operation === 'createChat' && pending.firstMessage) {
      const existing = next.drafts.find((draft) => isSameTarget(draft.target, conversation.target));
      if (!existing) {
        const draft = next.newDraft ?? pending.firstMessage.text;
        const mentions = next.newDraft ? next.newDraftMentions : pending.firstMessage.mentions;
        if (draft && next.drafts.length >= maximumDrafts) return refuse('created-draft-limit');
        if (draft)
          next.drafts.push({
            target: conversation.target,
            text: draft,
            ...(mentions?.length ? { mentions } : {}),
          });
        delete next.newDraft;
        delete next.newDraftMentions;
      } else if (next.newDraft === pending.firstMessage.text) {
        delete next.newDraft;
        delete next.newDraftMentions;
      }
      if (!next.selected) next.selected = conversation.target;
    } else next.selected = conversation.target;
  }
  if (firstSend) next.pending.push(firstSend);
  return next;
}

/** The Send of a created chat's first message, under the identity reserved with the Create. */
export function makeFirstSend(
  pending: Pending,
  receipt: ChatOutput<'createChat'>,
): Pending | undefined {
  if (pending.operation !== 'createChat' || !pending.firstMessage) return undefined;
  return {
    operation: 'sendChat',
    input: { ...pending.firstMessage, target: receipt.conversation.target },
    message: 'Outcome pending. Original first message retained.',
  };
}

/** `saved` with `requestId`'s note replaced. */
export function notePending(saved: Saved, requestId: string, message: string): Saved {
  const next = structuredClone(saved);
  const item = next.pending.find((entry) => entry.input.requestId === requestId);
  if (item) item.message = message;
  return next;
}

/** A failed dispatch's note: the failure's text, or fixed text when it doesn't fit. */
export function describePendingFailure(error: unknown) {
  const text = describeChatFailure(error);
  return isBoundedText(text, 1024) ? text : 'Original command outcome retained.';
}
