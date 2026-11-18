import { createContext } from 'react';

/** What a message's links and code blocks ask of the transcript. */
export type MarkdownActions = {
  openLink(url: string): void;
  /**
   * Whether code blocks offer Copy. Their buttons carry `data-copy-code` (the block's source
   * offset), and the part around the message handles the click.
   */
  copyCode?: boolean;
};
/** Source offsets of the active Find match. */
export type FindTarget = { start: number; end: number };
/** The active Find match in a message. Keeps its identity while the match is unchanged. */
export const ActiveFindMatch = createContext<FindTarget | null>(null);
