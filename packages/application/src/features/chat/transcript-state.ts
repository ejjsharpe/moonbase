import type {
  ChatEntry,
  ChatTranscriptMatch,
  ChatTranscriptPart,
  ChatTranscriptSelection,
  ChatTranscriptSource,
} from '@moonbase/contracts/chat';
import type { TranscriptView } from './view-memory.ts';
import { countTranscriptBytes, type TranscriptChunk } from './transcript-read.ts';

export const transcriptLimits = {
  displayedRows: 128,
  summaryRecords: 256,
  summaryBytes: 2 * 1024 * 1024,
  contentBytes: 8 * 1024 * 1024,
  findMatches: 256,
  /** How long closing waits for cancelled ChatClient reads to settle before releasing anyway. */
  closeGraceMs: 1000,
} as const;
export type TranscriptReadStatus = 'partial' | 'loading' | 'complete' | 'error' | 'source-changed';
export type TranscriptContentState = {
  source: ChatTranscriptSource;
  selection: ChatTranscriptSelection;
  chunks: TranscriptChunk[];
  loadedBytes: number;
  loadedText: number;
  retainedFrom: number;
  nextCursor: string | null;
  status: TranscriptReadStatus;
  error: string | null;
};
export type TranscriptManifestState = {
  source: ChatTranscriptSource;
  parts: ChatTranscriptPart[];
  nextCursor: string | null;
  omittedParts: number;
  status: TranscriptReadStatus;
  error: string | null;
};
export type TranscriptState = {
  capabilities: {
    transcript: 'unknown' | 'available' | 'legacy';
    find: 'available' | 'unavailable';
  };
  find: TranscriptFindState;
  observation: 'inactive' | 'local' | 'streaming' | 'legacy' | 'reconnecting' | 'failed';
  entries: ChatEntry[];
  earlier: boolean;
  later: boolean;
  atLatest: boolean;
  loading: boolean;
  error: string | null;
  view: TranscriptView;
  manifest: TranscriptManifestState | null;
  content: TranscriptContentState[];
};
export type TranscriptFindState = {
  open: boolean;
  revealing: boolean;
  query: string;
  status: 'idle' | 'searching' | 'complete' | 'error';
  error: string | null;
  matches: ChatTranscriptMatch[];
  retainedFrom: number;
  count: number;
  active: ChatTranscriptMatch | null;
  activeIndex: number | null;
  upperEntryId: string | null;
  refreshAvailable: boolean;
};
export const makeEmptyFindState = (): TranscriptFindState => ({
  open: false,
  revealing: false,
  query: '',
  status: 'idle',
  error: null,
  matches: [],
  retainedFrom: 0,
  count: 0,
  active: null,
  activeIndex: null,
  upperEntryId: null,
  refreshAvailable: false,
});
export function makeEmptyTranscriptState(): TranscriptState {
  return {
    capabilities: { transcript: 'unknown', find: 'unavailable' },
    find: makeEmptyFindState(),
    observation: 'inactive',
    entries: [],
    earlier: false,
    later: false,
    atLatest: true,
    loading: false,
    error: null,
    view: { anchor: null, expanded: [] },
    manifest: null,
    content: [],
  };
}

const measured = new WeakMap<object, number>();
/** Serialized bytes of an immutable retained value (entry, part, chunk, view), measured once. */
export function measureTranscriptValue(value: object) {
  let size = measured.get(value);
  if (size === undefined) measured.set(value, (size = countTranscriptBytes(value)));
  return size;
}
