import { Schema, Struct } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import {
  ChatSessionSchema,
  ChatTargetSchema,
  ChatIdentifierSchema,
  ChatModelPreferenceSchema,
  ChatMentionSchema,
  areChatMentionsInText,
  chatInputSchemas,
  maximumChatMentions,
  type ChatSession,
  type ChatTarget,
} from '@moonbase/contracts/chat';

const struct = <const F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Struct(fields).mapFields(Struct.map(Schema.mutableKey));
const array = <S extends Schema.Constraint>(value: S) => Schema.mutable(Schema.Array(value));
const text = (limit: number) =>
  Schema.String.check(
    Schema.makeFilter(
      (value) =>
        value.isWellFormed() &&
        !value.includes('\0') &&
        new TextEncoder().encode(value).length <= limit,
    ),
  );
const mentions = Schema.optionalKey(
  array(ChatMentionSchema).check(Schema.isMaxLength(maximumChatMentions)),
);
const pending = Schema.Union([
  struct({
    operation: Schema.Literal('createChat'),
    input: chatInputSchemas.createChat,
    firstMessage: Schema.optionalKey(
      struct({ requestId: ChatIdentifierSchema, text: text(32768), mentions }).check(
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
/** Chats you have looked at, newest look first, with the activity time you saw. */
export const seenLimit = 1000;
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
  newDraft: Schema.optionalKey(text(32768)),
  newDraftMentions: mentions,
  modelPreference: Schema.optionalKey(ChatModelPreferenceSchema),
  drafts: array(
    struct({ target: ChatTargetSchema, text: text(32768), mentions }).check(
      Schema.makeFilter(areChatMentionsInText),
    ),
  ).check(Schema.isMaxLength(32)),
  pending: array(pending).check(Schema.isMaxLength(16)),
  seen,
});
export type Saved = typeof SavedSchema.Type;
export type Pending = typeof pending.Type;
export const sameSession = (a: ChatSession, b: ChatSession) =>
  a.host.hostId === b.host.hostId && a.host.storeId === b.host.storeId && a.actorId === b.actorId;
export const sameTarget = (a: ChatTarget | null, b: ChatTarget | null) =>
  a === b || (!!a && !!b && sameSession(a, b) && a.conversationId === b.conversationId);
const decode = Schema.decodeUnknownSync(SavedSchema, {
  onExcessProperty: 'error',
  reportInput: false,
});
export function decodeSaved(value: unknown, context: ChatSession): Saved {
  try {
    const saved = decode(value);
    if (
      !sameSession(saved.session, context) ||
      (saved.selected && !sameSession(saved.selected, context))
    )
      throw Error();
    const drafts = new Set<string>(),
      requests = new Set<string>();
    for (const draft of saved.drafts) {
      if (!sameSession(draft.target, context) || drafts.has(draft.target.conversationId))
        throw Error();
      drafts.add(draft.target.conversationId);
    }
    if (
      saved.newDraftMentions &&
      !areChatMentionsInText({ text: saved.newDraft ?? '', mentions: saved.newDraftMentions })
    )
      throw Error();
    for (const item of saved.pending) {
      let session: ChatSession;
      if (item.operation === 'createChat') session = item.input.session;
      else if (item.operation === 'sendChat') session = item.input.target;
      else session = item.input.stop.target;
      if (!sameSession(session, context) || requests.has(item.input.requestId)) throw Error();
      requests.add(item.input.requestId);
      if (item.operation === 'createChat' && item.firstMessage) {
        if (requests.has(item.firstMessage.requestId) || !item.firstMessage.text.trim())
          throw Error();
        requests.add(item.firstMessage.requestId);
      }
    }
    return saved;
  } catch {
    throw new ApplicationError({
      code: 'Persistence',
      message:
        'Saved drafts have an incompatible context or format. Preserve the existing chat data; use its original host/store/actor.',
    });
  }
}
