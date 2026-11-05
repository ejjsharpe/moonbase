import type { ChatOutput, ChatTarget, ChatTranscriptMatch } from '@moonbase/contracts/chat';
import { getChatFindExpression } from '@moonbase/contracts/chat';
import { sameTarget } from './saved.ts';
import {
  areTranscriptValuesEqual,
  getTranscriptKey,
  makeTranscriptFailure,
  trackTranscriptCursor,
} from './transcript-read.ts';
import { transcriptLimits, type TranscriptFindState } from './transcript-state.ts';

export type FindPage = ChatOutput<'findChatTranscript'>;
/** The fixed boundary a Find reported on its first page; replay and refresh check against it. */
export type FindBoundary = { start: string | null; upper: string | null | undefined };

const isNumeric = (value: string) => /^\d+$/.test(value);

/**
 * One pass over Find pages from a start cursor. Each page must echo its request, keep the fixed
 * boundary, advance, and return original-text matches in order without repeats.
 */
export class TranscriptFindPass {
  private progress = { entries: 0, bytes: 0 };
  private advance = trackTranscriptCursor();
  private last?: ChatTranscriptMatch;
  private target: ChatTarget;
  private query: string;
  constructor(target: ChatTarget, query: string) {
    this.target = target;
    this.query = query;
  }
  checkPage(page: FindPage, cursor: string | null, boundary: FindBoundary) {
    const { progress, query } = this;
    if (
      !sameTarget(page.target, this.target) ||
      page.query !== query ||
      page.cursor !== cursor ||
      (boundary.start !== null && page.startCursor !== boundary.start) ||
      (boundary.upper !== undefined && page.upperEntryId !== boundary.upper) ||
      page.progress.entries < progress.entries ||
      page.progress.bytes < progress.bytes ||
      (page.nextCursor !== null &&
        page.progress.entries === progress.entries &&
        page.progress.bytes === progress.bytes)
    )
      throw makeTranscriptFailure(
        'Find reply does not match the query or advance its fixed boundary.',
      );
    const expression = getChatFindExpression(query);
    let last = this.last;
    const seen = new Set<string>();
    for (const match of page.matches) {
      const key = getTranscriptKey([match.source, match.partId, match.start, match.end]);
      if (
        seen.has(key) ||
        (last &&
          areTranscriptValuesEqual(last.source, match.source) &&
          last.partId === match.partId &&
          match.start < last.end) ||
        (last &&
          isNumeric(last.source.entryId) &&
          isNumeric(match.source.entryId) &&
          Number(match.source.entryId) < Number(last.source.entryId))
      )
        throw makeTranscriptFailure('Find repeats or reverses an original-text match.');
      seen.add(key);
      last = match;
      const start = match.start - match.snippet.start,
        end = match.end - match.snippet.start;
      expression.lastIndex = 0;
      const hit = expression.exec(match.snippet.text.slice(start, end));
      if (
        !sameTarget(match.source.target, this.target) ||
        page.upperEntryId === null ||
        (isNumeric(match.source.entryId) &&
          isNumeric(page.upperEntryId) &&
          Number(match.source.entryId) > Number(page.upperEntryId)) ||
        hit?.index !== 0 ||
        hit[0].length !== end - start
      )
        throw makeTranscriptFailure('Find returned an invalid original-text match.');
    }
    this.advance(cursor, page.nextCursor);
    this.progress = page.progress;
    this.last = page.matches.at(-1) ?? this.last;
    return page;
  }
}

/** Adds a page's matches, retaining the newest `findMatches` and activating the first match. */
export function appendFindPage(
  previous: TranscriptFindState,
  page: FindPage,
  boundary: string | null | undefined,
): TranscriptFindState {
  const matches = [...previous.matches, ...page.matches].slice(-transcriptLimits.findMatches);
  const count = previous.count + page.matches.length;
  const find: TranscriptFindState = {
    ...previous,
    matches,
    retainedFrom: count - matches.length,
    count,
    upperEntryId: page.upperEntryId,
    refreshAvailable: page.upperEntryId !== boundary,
    status: page.nextCursor ? 'searching' : 'complete',
  };
  const first = previous.active === null && page.matches[0];
  return first ? { ...find, active: first, activeIndex: previous.count } : find;
}
