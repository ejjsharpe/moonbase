import type { ChatFileMatch } from '@moonbase/contracts/chat';

/** What a composer's file picker shows. */
export type ChatFileSearchSnapshot = {
  /** The query the matches answer, or null before any answer. */
  query: string | null;
  matches: ChatFileMatch[];
  partial: boolean;
  busy: boolean;
  error: string | null;
};

export const idleFileSearch: ChatFileSearchSnapshot = {
  query: null,
  matches: [],
  partial: false,
  busy: false,
  error: null,
};
