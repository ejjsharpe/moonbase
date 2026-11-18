import { Schema } from 'effect';
import { array, struct } from '@moonbase/contracts/schema';
import {
  ChatSessionSchema,
  ChatTargetSchema,
  ChatIdentifierSchema,
  ChatModelPreferenceSchema,
  ChatMentionSchema,
  areChatMentionsInText,
  chatInputSchemas,
} from '@moonbase/contracts/chat-schema';
import {
  findChatMentionStarts,
  isChatMentionPath,
  maximumChatMentions,
  type ChatMention,
  type ChatSession,
  type ChatSummary,
  type ChatTarget,
} from '@moonbase/contracts/chat';
import { isSameChatTarget } from '@moonbase/contracts/chat-validation';
import type { ChatRefusalReason } from '../chat-errors.ts';

// What a chat keeps across restarts (its drafts, the selected chat, the pending commands whose
// outcome isn't known yet and the activity you have seen), and the pure rules for changing it.

export const maximumSavedBytes = 2 * 1024 * 1024;
export const maximumDraftBytes = 32768;
export const maximumDrafts = 32;
export const maximumPending = 16;
/** Chats you have looked at, newest look first, with the activity time you saw. */
export const seenLimit = 1000;

export const countBytes = (value: string) => new TextEncoder().encode(value).length;
/** Well-formed text without NUL, at most `limit` UTF-8 bytes. */
export const isBoundedText = (value: string, limit: number) =>
  value.isWellFormed() && !value.includes('\0') && countBytes(value) <= limit;
const text = (limit: number) =>
  Schema.String.check(Schema.makeFilter((value) => isBoundedText(value, limit)));
const mentions = Schema.optionalKey(
  array(ChatMentionSchema).check(Schema.isMaxLength(maximumChatMentions)),
);
const PendingSchema = Schema.Union([
  struct({
    operation: Schema.Literal('createChat'),
    input: chatInputSchemas.createChat,
    firstMessage: Schema.optionalKey(
      struct({ requestId: ChatIdentifierSchema, text: text(maximumDraftBytes), mentions }).check(
        Schema.makeFilter(areChatMentionsInText),
      ),
    ),
    message: text(1024),
  }),
  struct({
    operation: Schema.Literal('sendChat'),
    input: chatInputSchemas.sendChat,
    message: text(1024),
  }),
  struct({
    operation: Schema.Literal('stopChat'),
    input: chatInputSchemas.stopChat,
    message: text(1024),
  }),
]);
const seen = Schema.optionalKey(
  array(
    struct({
      conversationId: ChatIdentifierSchema,
      at: text(64).check(Schema.makeFilter((value) => Number.isFinite(Date.parse(value)))),
    }),
  ).check(Schema.isMaxLength(seenLimit)),
);
const SavedSchema = struct({
  version: Schema.Literal(1),
  session: ChatSessionSchema,
  selected: Schema.NullOr(ChatTargetSchema),
  newDraft: Schema.optionalKey(text(maximumDraftBytes)),
  newDraftMentions: mentions,
  modelPreference: Schema.optionalKey(ChatModelPreferenceSchema),
  drafts: array(
    struct({ target: ChatTargetSchema, text: text(maximumDraftBytes), mentions }).check(
      Schema.makeFilter(areChatMentionsInText),
    ),
  ).check(Schema.isMaxLength(maximumDrafts)),
  pending: array(PendingSchema).check(Schema.isMaxLength(maximumPending)),
  seen,
});
export type Saved = typeof SavedSchema.Type;
/** A command whose outcome isn't known yet, kept with its original identity. */
export type Pending = typeof PendingSchema.Type;

export const isSameSession = (a: ChatSession, b: ChatSession) =>
  a.host.hostId === b.host.hostId && a.host.storeId === b.host.storeId && a.actorId === b.actorId;
export const isSameTarget = (a: ChatTarget | null, b: ChatTarget | null) =>
  a === b || (!!a && !!b && isSameChatTarget(a, b));

export const emptySaved = (session: ChatSession): Saved => ({
  version: 1,
  session: structuredClone(session),
  selected: null,
  drafts: [],
  pending: [],
});

const decode = Schema.decodeUnknownOption(SavedSchema, {
  onExcessProperty: 'error',
  reportInput: false,
});
/** Whether `saved` is all of `session`'s, with no draft or request named twice. */
function isConsistent(saved: Saved, session: ChatSession) {
  if (
    !isSameSession(saved.session, session) ||
    (saved.selected && !isSameSession(saved.selected, session))
  )
    return false;
  const drafts = new Set<string>(),
    requests = new Set<string>();
  for (const draft of saved.drafts) {
    if (!isSameSession(draft.target, session) || drafts.has(draft.target.conversationId))
      return false;
    drafts.add(draft.target.conversationId);
  }
  if (
    saved.newDraftMentions &&
    !areChatMentionsInText({ text: saved.newDraft ?? '', mentions: saved.newDraftMentions })
  )
    return false;
  for (const item of saved.pending) {
    let owner: ChatSession;
    if (item.operation === 'createChat') owner = item.input.session;
    else if (item.operation === 'sendChat') owner = item.input.target;
    else owner = item.input.stop.target;
    if (!isSameSession(owner, session) || requests.has(item.input.requestId)) return false;
    requests.add(item.input.requestId);
    if (item.operation === 'createChat' && item.firstMessage) {
      if (requests.has(item.firstMessage.requestId) || !item.firstMessage.text.trim()) return false;
      requests.add(item.firstMessage.requestId);
    }
  }
  return true;
}
/** `value` as `session`'s saved chat data, or undefined if it isn't valid. */
export function decodeSaved(value: unknown, session: ChatSession): Saved | undefined {
  const decoded = decode(value);
  return decoded._tag === 'Some' && isConsistent(decoded.value, session)
    ? decoded.value
    : undefined;
}

/** The draft shown for the selected chat, or the new chat's. */
export function readDraft(saved: Saved): { text: string; mentions: ChatMention[] } {
  if (!saved.selected)
    return { text: saved.newDraft ?? '', mentions: saved.newDraftMentions ?? [] };
  const draft = saved.drafts.find((item) => isSameTarget(item.target, saved.selected));
  return { text: draft?.text ?? '', mentions: draft?.mentions ?? [] };
}

/**
 * The mentions a draft of `text` keeps from `mentions`: those it still spells, once each. A
 * mention the saved format rejects is refused before it is shown, so it never blocks storage.
 */
export function keepMentions(
  text: string,
  mentions: readonly ChatMention[],
): ChatMention[] | ChatRefusalReason {
  if (!isBoundedText(text, maximumDraftBytes)) return 'message-text';
  const kept = [
    ...new Map(
      mentions
        .filter((mention) => findChatMentionStarts(text, mention.path).length)
        .map((mention) => [mention.path, { path: mention.path }]),
    ).values(),
  ];
  if (kept.length > maximumChatMentions) return 'too-many-mentions';
  if (kept.some((mention) => !isChatMentionPath(mention.path))) return 'mention-path';
  return kept;
}

/**
 * `saved` with the selected chat's draft (or the new chat's) replaced. The rest keeps its identity,
 * so what reads the selection, pending commands or seen activity is not told of each keystroke.
 */
export function writeDraft(saved: Saved, text: string, mentions: ChatMention[]): Saved {
  const target = saved.selected;
  if (!target) {
    const { newDraft: _text, newDraftMentions: _mentions, ...rest } = saved;
    return {
      ...rest,
      ...(text ? { newDraft: text } : {}),
      ...(mentions.length ? { newDraftMentions: [...mentions] } : {}),
    };
  }
  const others = saved.drafts.filter((draft) => !isSameTarget(draft.target, target));
  if (!text) return { ...saved, drafts: others };
  const index = saved.drafts.findIndex((draft) => isSameTarget(draft.target, target));
  const draft = { target, text, ...(mentions.length ? { mentions: [...mentions] } : {}) };
  const drafts =
    index >= 0 ? saved.drafts.map((item, at) => (at === index ? draft : item)) : [...others, draft];
  return { ...saved, drafts };
}

/** `seen` with a look at `conversationId` as of `at`; undefined if a newer look is recorded. */
export function recordSeen(saved: Saved, conversationId: string, at: string): Saved | undefined {
  const seen = saved.seen ?? [];
  const current = seen.find((item) => item.conversationId === conversationId);
  if (current && Date.parse(current.at) >= Date.parse(at)) return undefined;
  return {
    ...saved,
    seen: [
      { conversationId, at },
      ...seen.filter((item) => item.conversationId !== conversationId),
    ].slice(0, seenLimit),
  };
}

/** Before anything was marked, every listed chat counts as seen, so old work is not all Ready. */
export const seeListed = (saved: Saved, chats: readonly ChatSummary[]): Saved => ({
  ...saved,
  seen: chats
    .map((chat) => ({
      conversationId: chat.target.conversationId,
      at: chat.activity?.at ?? chat.createdAt,
    }))
    .slice(0, seenLimit),
});
