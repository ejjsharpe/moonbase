import type { ApplicationError, CommandOptions, ObservationClose } from './workspace.ts';
import type * as Contracts from './chat-schema.ts';

export const maximumChatInputBytes = 32 * 1024;
// JSON can escape each input byte as \uXXXX; identifiers and envelope fields fit in 4 KiB.
export const maximumChatRequestBytes = 6 * maximumChatInputBytes + 4096;
export const maximumChatReplyBytes = 256 * 1024;
export const chatPageSize = 32;
export const chatPreviewBytes = 4096;
/**
 * The text a running response's transcript parts carry in all, so its reply renders as it streams
 * without reading content: its text parts whole while they fit, the rest as previews.
 */
export const chatLiveTextBytes = 64 * 1024;
export const chatContentChunkBytes = 32 * 1024;
export const chatManifestPageSize = 32;
export const maximumChatFindQueryBytes = 1024;
export const chatFindPageSize = 32;
export const maximumChatMentions = 32;
export const maximumChatFileQueryBytes = 256;
export const chatFileMatchLimit = 50;
/** A mention's spelling in message text: `@path`, quoted when the path contains whitespace. */
export const formatChatMention = (path: string) => (/\s/.test(path) ? `@"${path}"` : `@${path}`);
/** Whether a mention spelled up to `at` ends there: at whitespace or trailing punctuation, not inside a longer path such as `a.tsx`. */
export const isChatMentionEnd = (text: string, at: number) =>
  at >= text.length || /^(?:\s|[,;:!?)\]}]|\.(?:\s|$))/.test(text.slice(at, at + 2));
/** Where `path`'s mention is spelled in `text` as a whole token, after whitespace or the start. */
export function findChatMentionStarts(text: string, path: string) {
  const token = formatChatMention(path),
    starts: number[] = [];
  for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + 1))
    if ((at === 0 || /\s/.test(text[at - 1]!)) && isChatMentionEnd(text, at + token.length))
      starts.push(at);
  return starts;
}
/** A path relative to the chat's working folder, without `.`/`..` segments, quotes or control characters. */
export const isChatMentionPath = (path: string) =>
  !/[\ud800-\udfff]/u.test(path) &&
  new TextEncoder().encode(path).length <= 1024 &&
  // oxlint-disable-next-line no-control-regex -- Mention paths reject control characters.
  !/[\0-\x1f\x7f"\\]/.test(path) &&
  path.split('/').every((segment) => !!segment && segment !== '.' && segment !== '..');
/** Find's literal matching rule over original text; Unicode behaviour is in the README. */
export const getChatFindExpression = (query: string) =>
  new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
export type ChatTranscriptMatch = typeof Contracts.ChatTranscriptMatchSchema.Type;
/** A file in the chat's working folder that a message refers to, by relative path. */
export type ChatMention = typeof Contracts.ChatMentionSchema.Type;
export type ChatFileMatch = typeof Contracts.ChatFileMatchSchema.Type;
export type ChatTranscriptSource = typeof Contracts.ChatTranscriptSourceSchema.Type;
export type ChatTranscriptPart = typeof Contracts.ChatTranscriptPartSchema.Type;
export type ChatTranscriptSelection = typeof Contracts.ChatTranscriptSelectionSchema.Type;
export type ChatTranscript = typeof Contracts.ChatTranscriptSchema.Type;
export type ChatCreationSettings = typeof Contracts.ChatCreationSettingsSchema.Type;
export type ChatModelPreference = typeof Contracts.ChatModelPreferenceSchema.Type;
export type ChatReasoningEffort = typeof Contracts.ChatReasoningEffortSchema.Type;
export type ChatSession = typeof Contracts.ChatSessionSchema.Type;
export type ChatTarget = typeof Contracts.ChatTargetSchema.Type;
export type ChatHostConfiguration = typeof Contracts.ChatHostConfigurationSchema.Type;
export type ChatSummary = typeof Contracts.ChatSummarySchema.Type;
export type ChatActivity = typeof Contracts.ChatActivitySchema.Type;
export type ChatEntry = typeof Contracts.ChatEntrySchema.Type;
/** Newest first, with an opaque cursor for the next older page. */
export type ChatHistoryPage = typeof Contracts.ChatHistoryPageSchema.Type;
export type ChatStopTarget = typeof Contracts.ChatStopTargetSchema.Type;
export type ChatRun = typeof Contracts.ChatRunSchema.Type;
/** A bounded replacement snapshot, never an unbounded append-only event feed. */
export type ChatSnapshot = typeof Contracts.ChatSnapshotSchema.Type;
export type ChatSendReceipt = typeof Contracts.ChatSendReceiptSchema.Type;
export type ChatCommand = keyof typeof Contracts.chatInputSchemas;
export type ChatCommands = {
  [K in ChatCommand]: {
    input: (typeof Contracts.chatInputSchemas)[K]['Type'];
    output: (typeof Contracts.chatOutputSchemas)[K]['Type'];
  };
};
export type ChatInput<K extends ChatCommand> = ChatCommands[K]['input'];
export type ChatOutput<K extends ChatCommand> = ChatCommands[K]['output'];
/**
 * What a chat list watch follows: the list's first page, and chats past it that changed while it
 * watched, as they are now (the most recently changed, at most `chatPageSize` and within the reply
 * limit). `dropped` counts changed chats it let go to stay within those bounds; a client that sees
 * it grow lists again, since one of them may have changed unseen.
 */
export type ChatListState = {
  list: ChatOutput<'listChats'>;
  changed: ChatSummary[];
  dropped: number;
};
/**
 * A chat list watch's state. `reset` marks one that replaced the watch's state after updates may
 * have been missed (a reconnect that could not resume), so chats past the first page may have
 * changed unseen.
 */
export type ChatListUpdate = ChatListState & { reset: boolean };
/** An implementation that receives untrusted data decodes and bounds every reply and snapshot. */
export interface ChatClient {
  command<K extends ChatCommand>(
    operation: K,
    input: ChatInput<K>,
    options?: CommandOptions,
  ): Promise<ChatOutput<K>>;
  watch(
    input: { target: ChatTarget },
    receive: (snapshot: ChatSnapshot) => void,
    onError: (error: ApplicationError) => void,
  ): ObservationClose;
  /** The chat list's first page and changed chats past it, again after each change. */
  watchChatList(
    input: { session: ChatSession },
    receive: (update: ChatListUpdate) => void,
    onError: (error: ApplicationError) => void,
  ): ObservationClose;
}
