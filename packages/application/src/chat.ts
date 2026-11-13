export { makeChatModel, makeChatController } from './features/chat/controller.ts';
export type {
  ChatController,
  ChatModel,
  ChatDependencies,
  ChatState,
  Pending,
  DraftStorage,
} from './features/chat/controller.ts';

export { groupChatsByActivity } from './features/chat/activity.ts';
export type {
  ActiveChat,
  ChatActivityGroups,
  ChatActivityReason,
} from './features/chat/activity.ts';
export { ChatFileSearch, type ChatFileSearchSnapshot } from './features/chat/file-search.ts';
export {
  type ProviderSetupController,
  type ProviderSetupSnapshot,
} from './features/chat/providers.ts';

export { iterateTranscriptSource, makeTranscriptReader } from './features/chat/transcript-read.ts';
export type { TranscriptRead, TranscriptChunk } from './features/chat/transcript-read.ts';
export { TranscriptViewMemory } from './features/chat/view-memory.ts';
export type { TranscriptView, TranscriptViewAnchor } from './features/chat/view-memory.ts';
export { findRowEntryId, getEntryRowKey, isLiveRowKey } from './features/chat/transcript-rows.ts';
export type { LiveEntry, TranscriptRow } from './features/chat/transcript-rows.ts';
export { transcriptLimits } from './features/chat/transcript-state.ts';
export type {
  TranscriptState,
  TranscriptFindState,
  TranscriptManifestState,
  TranscriptContentState,
} from './features/chat/transcript-state.ts';
