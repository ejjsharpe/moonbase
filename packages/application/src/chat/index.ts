export { chatLayer, type ChatServices } from './chat-layer.ts';
export { getChatAtoms, type ChatAtoms } from './chat-atoms.ts';
export { readChatState, watchChatState, toChatState, type ChatState } from './chat-state.ts';
export type {
  ChatDependencies,
  ChatPort,
  ConnectionPort,
  ProviderSetupPort,
  DraftStorage,
} from './chat-ports.ts';
export {
  ChatRefusedError,
  DraftStorageError,
  NewChatDraftError,
  describeChatFailure,
  type ChatRefusalReason,
} from './chat-errors.ts';
export { ChatConfig } from './chat-config.ts';
export { ChatActions, type ChatActionsShape } from './actions/actions-service.ts';
export { ChatDrafts, type ChatDraftsShape, type DraftsState } from './drafts/drafts-service.ts';
export type { Pending, Saved } from './drafts/drafts.ts';
export { ChatLink, type ChatLinkShape, type LinkState } from './link/link-service.ts';
export { ChatConnection, type ChatConnectionShape } from './connection/connection-service.ts';
export { ChatList, type ChatListShape } from './chat-list/chat-list-service.ts';
export { groupChatsByActivity } from './chat-list/chat-activity.ts';
export type {
  ActiveChat,
  ChatActivityGroups,
  ChatActivityReason,
} from './chat-list/chat-activity.ts';
export {
  ChatSelection,
  type ChatSelectionShape,
  type SelectionState,
} from './selection/selection-service.ts';
export { ChatSends, type ChatSendsShape, type SendsState } from './sends/sends-service.ts';
export {
  ChatFileSearch,
  type ChatFileSearchShape,
  type FileSearch,
} from './file-search/file-search-service.ts';
export type { ChatFileSearchSnapshot } from './file-search/file-search.ts';
export {
  ChatProviderSetup,
  type ChatProviderSetupShape,
  type ProviderSetupSnapshot,
} from './provider-setup/provider-setup-service.ts';

export {
  makeTranscript,
  type Transcript,
  type TranscriptDependencies,
} from './transcript/transcript.ts';
export {
  checkTranscript,
  TranscriptReadError,
  type TranscriptReadProblem,
} from './transcript/transcript-errors.ts';
export {
  checkTranscriptReply,
  countDecodedTranscriptBytes,
  streamTranscriptSource,
  trackTranscriptCursor,
} from './transcript/transcript-read.ts';
export type { TranscriptRead, TranscriptChunk } from './transcript/transcript-read.ts';
export { TranscriptViewMemory } from './transcript/transcript-view-memory.ts';
export type { TranscriptView, TranscriptViewAnchor } from './transcript/transcript-view-memory.ts';
export { findRowEntryId, getEntryRowKey, isLiveRowKey } from './transcript/transcript-rows.ts';
export type { LiveEntry, TranscriptRow } from './transcript/transcript-rows.ts';
export { defaultTranscriptLimits } from './transcript/transcript-state.ts';
export {
  collectResultsByCall,
  getCallKey,
  getTranscriptParts,
  type ResultsByCall,
} from './transcript/results-by-call.ts';
export {
  getTranscriptSourceKey,
  type TranscriptRowState,
} from './transcript/transcript-row-state.ts';
export { makeTranscriptAtoms, type TranscriptAtoms } from './transcript/transcript-atoms.ts';
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
export { makeComposerChat } from './composer/composer-chat.ts';
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
export { makeNativeActions, type NativeActions } from './native-actions/native-actions-runner.ts';
export { nativeActionsAtoms } from './native-actions/native-actions-atoms.ts';
export {
  busyNotice,
  doneNotice,
  offlineNotice,
  pendingNotice,
  type NativeActionKind,
  type TranscriptNotice,
} from './native-actions/native-actions.ts';
