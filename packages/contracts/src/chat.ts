import type { ApplicationError, CommandOptions, ObservationClose } from './workspace.ts';
import type * as Contracts from './chat-schema.ts';

export const maximumChatInputBytes = 32 * 1024;
// JSON can escape each input byte as \uXXXX; identifiers and envelope fields fit in 4 KiB.
export const maximumChatRequestBytes = 6 * maximumChatInputBytes + 4096;
export const maximumChatReplyBytes = 256 * 1024;
export const chatPageSize = 32;
export const chatPreviewBytes = 4096;
export const chatContentChunkBytes = 32 * 1024;
export const chatManifestPageSize = 32;
export const maximumChatFindQueryBytes = 1024;
export const chatFindPageSize = 32;
export const chatFindFeature = 'transcript-find-v1';
export type ChatTranscriptMatch = typeof Contracts.ChatTranscriptMatchSchema.Type;
export const chatStreamFeature = 'chat-stream-v1';
export type ChatStreamRequest = typeof Contracts.ChatStreamRequestSchema.Type;
export type ChatStreamFrame = typeof Contracts.ChatStreamFrameSchema.Type;
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
export type ChatEntry = typeof Contracts.ChatEntrySchema.Type;
/** Newest first, with an opaque cursor for the next older page. */
export type ChatHistoryPage = typeof Contracts.ChatHistoryPageSchema.Type;
export type ChatStopTarget = typeof Contracts.ChatStopTargetSchema.Type;
export type ChatToolActivity = typeof Contracts.ChatToolActivitySchema.Type;
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
}
