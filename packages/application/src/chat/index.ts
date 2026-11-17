export { makeChatModel, makeChatController } from './controller.ts';
export type { ChatRunner } from './chat-promises.ts';
export type {
  ChatController,
  ChatModel,
  ChatDependencies,
  ChatState,
  Pending,
  DraftStorage,
} from './controller.ts';

export { groupChatsByActivity } from './activity.ts';
export type { ActiveChat, ChatActivityGroups, ChatActivityReason } from './activity.ts';
export { ChatFileSearch, type ChatFileSearchSnapshot } from './file-search.ts';
export { type ProviderSetupController, type ProviderSetupSnapshot } from './provider-setup.ts';

export { iterateTranscriptSource, makeTranscriptReader } from './transcript/transcript-read.ts';
export type { TranscriptRead, TranscriptChunk } from './transcript/transcript-read.ts';
export { TranscriptViewMemory } from './transcript/transcript-view-memory.ts';
export type { TranscriptView, TranscriptViewAnchor } from './transcript/transcript-view-memory.ts';
export { findRowEntryId, getEntryRowKey, isLiveRowKey } from './transcript/transcript-rows.ts';
export type { LiveEntry, TranscriptRow } from './transcript/transcript-rows.ts';
export { defaultTranscriptLimits } from './transcript/transcript-state.ts';
export type {
  TranscriptLimits,
  TranscriptState,
  TranscriptFindState,
  TranscriptManifestState,
  TranscriptContentState,
} from './transcript/transcript-state.ts';

export {
  ChatComposers,
  type ChatComposer,
  type ComposerChat,
  type CreateWorktree,
} from './composer/composer-service.ts';
export { composerAtoms } from './composer/composer-atoms.ts';
export {
  findChatFolder,
  findComposerPlace,
  findMentionClash,
  findSelectedChat,
  isMessageFor,
  readChoices,
  type ChatComposerSnapshot,
  type ComposerChoices,
  type ComposerMessage,
  type ComposerPlace,
} from './composer/composer.ts';
export {
  appendMentions,
  findMentionQuery,
  findMentionRanges,
  insertMention,
  rebaseMentions,
  removeMentionBefore,
  type MentionQuery,
} from './composer/mention-text.ts';
export { chatWorktreeBranch } from './composer/worktree-branch.ts';
