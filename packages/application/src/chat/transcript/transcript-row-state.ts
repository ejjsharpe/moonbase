import type { ChatTranscriptMatch, ChatTranscriptSource } from '@moonbase/contracts/chat';
import { getJsonKey } from '@moonbase/contracts/common';
import type {
  TranscriptContentState,
  TranscriptManifestState,
  TranscriptState,
} from './transcript-state.ts';

/** What one row reads of its transcript: the state of its own source. */
export type TranscriptRowState = {
  /** The loaded manifest, when it describes this row's source. */
  manifest: TranscriptManifestState | null;
  /** The active Find match, when it is in this row. */
  findMatch: ChatTranscriptMatch | null;
  /** Find is revealing `findMatch`: it was just moved to, and no reader input ended that. */
  findRevealing: boolean;
  /** The Find query while this row has a match, else empty. */
  findQuery: string;
  /** Find matches in this row's source. */
  findMatches: readonly ChatTranscriptMatch[];
  /** Loaded content of this row's source. */
  contents: readonly TranscriptContentState[];
  /** View memory's expanded disclosures. */
  expanded: readonly string[];
  /** The live source can't be read now. */
  offline: boolean;
};

/** A row's key for its source: the same for equal sources, whatever their key order. */
export const getTranscriptSourceKey = (source: ChatTranscriptSource | undefined) =>
  source ? getJsonKey(source) : '';

/** The transcript's sourced state, grouped by source key once for every row to read. */
export type TranscriptSourceIndex = {
  contents: ReadonlyMap<string, readonly TranscriptContentState[]>;
  matches: ReadonlyMap<string, readonly ChatTranscriptMatch[]>;
  manifest: string;
  findMatch: string;
};
export function indexTranscriptSources(
  state: Pick<TranscriptState, 'content' | 'find' | 'manifest'>,
): TranscriptSourceIndex {
  return {
    contents: groupBySource(state.content),
    matches: groupBySource(state.find.matches),
    manifest: getTranscriptSourceKey(state.manifest?.source),
    findMatch: getTranscriptSourceKey(state.find.active?.source),
  };
}
function groupBySource<T extends { source: ChatTranscriptSource }>(items: readonly T[]) {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = getTranscriptSourceKey(item.source);
    const group = grouped.get(key);
    if (group) group.push(item);
    else grouped.set(key, [item]);
  }
  return grouped;
}

const none: readonly never[] = [];
const offline = new Set<TranscriptState['observation']>(['reconnecting', 'failed', 'inactive']);

/** The state of the row whose source has `key` (empty for a row with no transcript). */
export function selectTranscriptRowState(
  state: TranscriptState,
  index: TranscriptSourceIndex,
  key: string,
): TranscriptRowState {
  const findMatch = key && index.findMatch === key ? state.find.active : null;
  const findMatches = (key && index.matches.get(key)) || none;
  return {
    manifest: key && index.manifest === key ? state.manifest : null,
    findMatch,
    findRevealing: !!findMatch && state.find.revealing,
    findQuery: findMatch || findMatches.length ? state.find.query : '',
    findMatches,
    contents: (key && index.contents.get(key)) || none,
    expanded: state.view.expanded,
    offline: offline.has(state.observation),
  };
}

/** Whether two lists hold the same items, in order. */
export const isSameItems = (a: readonly unknown[], b: readonly unknown[]) =>
  a === b || (a.length === b.length && a.every((item, index) => item === b[index]));

/** Whether a row would show the same: its lists are rebuilt on each change, so they compare by item. */
export const isSameTranscriptRowState = (a: TranscriptRowState, b: TranscriptRowState) =>
  a.manifest === b.manifest &&
  a.findMatch === b.findMatch &&
  a.findRevealing === b.findRevealing &&
  a.findQuery === b.findQuery &&
  a.offline === b.offline &&
  isSameItems(a.findMatches, b.findMatches) &&
  isSameItems(a.contents, b.contents) &&
  isSameItems(a.expanded, b.expanded);
