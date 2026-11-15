import * as Schema from 'effect/Schema';
import { array, optional, struct } from './schema.ts';
import { chatManifestPageSize, chatPageSize, chatPreviewBytes } from './chat.ts';
import {
  ChatIdentifierSchema,
  ChatLiveTranscriptPartSchema,
  ChatSnapshotSchema,
  ChatSummarySchema,
  chatOutputSchemas,
} from './chat-schema.ts';
import { IncompatibleHostError } from './host-errors.ts';
import { ProviderStateSchema } from './providers-schema.ts';
import type { WatchKind, WatchValue } from './watch.ts';

const unicode = Schema.String.check(Schema.makeFilter((value) => !/[\ud800-\udfff]/u.test(value)));
const bytes = (limit: number) =>
  unicode.check(
    Schema.makeFilter(
      (value) => !value.includes('\0') && new TextEncoder().encode(value).length <= limit,
    ),
  );
const count = (maximum: number) => Schema.Int.check(Schema.isBetween({ minimum: 0, maximum }));
const sequence = count(Number.MAX_SAFE_INTEGER);
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const cursor = bytes(1024).check(Schema.makeFilter((value) => !!value.trim()));

/** The running response's changes: preview text replaced, parts' text appended or parts replaced. */
export const ChatDeltaSchema = struct({
  text: optional(bytes(chatPreviewBytes)),
  truncated: optional(Schema.Boolean),
  parts: optional(
    array(
      Schema.Union([
        struct({
          index: count(chatManifestPageSize - 1),
          append: unicode,
          bytes: sequence,
          revision: digest,
          truncated: Schema.Boolean,
        }),
        struct({ index: count(chatManifestPageSize - 1), part: ChatLiveTranscriptPartSchema }),
      ]),
    ).check(Schema.isMaxLength(chatManifestPageSize)),
  ),
  nextCursor: optional(Schema.NullOr(cursor)),
});
const rows = array(ChatSummarySchema).check(Schema.isMaxLength(chatPageSize));
const ids = array(ChatIdentifierSchema).check(Schema.isMaxLength(chatPageSize));
/** A chat list watch's first page and the changed chats past it (`ChatListState`). */
export const ChatListStateSchema = struct({
  list: chatOutputSchemas.listChats,
  changed: rows,
  dropped: sequence,
});
/**
 * Page rows upserted and removed; `order` lists the page's conversation IDs after the change.
 * `changed` upserts changed chats past the page and lists their IDs after the change.
 */
export const ChatListDeltaSchema = struct({
  upsert: rows,
  remove: ids,
  order: ids,
  nextCursor: Schema.NullOr(cursor),
  changed: optional(struct({ upsert: rows, order: ids })),
  dropped: optional(sequence),
});
/** The provider setup fields that changed. */
export const ProviderSetupDeltaSchema = struct({
  providers: optional(ProviderStateSchema.fields.providers),
  flow: optional(ProviderStateSchema.fields.flow),
});
const valueSchemas = {
  chat: ChatSnapshotSchema,
  chatList: ChatListStateSchema,
  providerSetup: ProviderStateSchema,
};
const values = Object.fromEntries(
  Object.entries(valueSchemas).map(([kind, schema]) => [
    kind,
    Schema.decodeUnknownSync(schema, { onExcessProperty: 'ignore', reportInput: false }),
  ]),
) as Record<WatchKind, (value: unknown) => unknown>;
/** A watch's value after a delta applied, decoded as its kind's; an invalid one is the daemon's fault. */
export function decodeWatchValue<K extends WatchKind>(kind: K, value: unknown): WatchValue<K> {
  try {
    return values[kind](value) as WatchValue<K>;
  } catch {
    throw new IncompatibleHostError({ reason: 'invalid-update' });
  }
}
