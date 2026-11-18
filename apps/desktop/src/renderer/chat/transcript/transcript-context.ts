import { createContext, useContext } from 'react';
import type { Effect } from 'effect';
import type { ChatSelectionShape } from '@moonbase/application/chat';
import type { ChatTarget } from '@moonbase/contracts/chat';
import type { MarkdownCache } from './markdown/markdown-model.ts';
import type { TranscriptActions, TranscriptNative } from './transcript-actions.ts';
import type { TranscriptView } from './transcript-view.ts';

/**
 * What every row of one transcript shares, fixed while it is mounted: the open chat's selection
 * and a way to run its actions, the atoms rows read their own state from, and the view's caches
 * and native actions. Rows subscribe to their atoms; nothing here changes per update.
 */
export type TranscriptShared = {
  selection: ChatSelectionShape;
  /** Runs a chat action on the renderer's root runtime; the chat shows its own failure. */
  act(action: Effect.Effect<void>): Promise<void>;
  /** The view's atoms: what it presents, its list items, and each row's state. */
  view: TranscriptView;
  /** The chat this transcript shows, and the backend serving it. */
  target: ChatTarget;
  backendId: string;
  cache: MarkdownCache;
  native: TranscriptNative | undefined;
  actions: TranscriptActions;
};
export const TranscriptContext = createContext<TranscriptShared | null>(null);

/** The transcript a row is in. */
export const useTranscript = () => useContext(TranscriptContext)!;
