import { ToolResultEntry, type EntryRecord, type Harness } from '@earendil-works/pi-durable';
import { Effect } from 'effect';
import { LRUCache } from 'lru-cache';
import type { ChatTarget, ChatTranscript } from '@moonbase/contracts/chat';
import { InvalidChatRequestError, type ChatError } from '@moonbase/contracts/chat-errors';
import { runCheck } from '../commands/safe-error.ts';
import { cid, eid } from '../documents.ts';
import { getEntryTextValues } from './message-values.ts';
import { readEntry } from './saved-entries.ts';
import { getPairing } from './tool-pairing.ts';
import { makeValuePart, partsPerTurn, summarizeThinking, type Part } from './transcript-part.ts';

/** Saved entries are immutable, so a host shares their built parts up to this budget. */
const entryCacheBytes = 32 * 1024 * 1024;
const partOverheadBytes = 512;
export type EntryTranscript = {
  /** Saved entries never move, so a cached transcript can authorize its own reads. */
  conversationId: EntryRecord['conversationId'];
  parts: Part[];
  thinking: ChatTranscript['thinking'];
};
export type EntryTranscriptCache = LRUCache<string, EntryTranscript>;
export const makeEntryTranscriptCache = (): EntryTranscriptCache =>
  new LRUCache<string, EntryTranscript>({
    maxSize: entryCacheBytes,
    // Parts are immutable once built, so this size never changes after insertion.
    sizeCalculation: (transcript) =>
      transcript.parts.reduce(
        (size, part) => size + part.value.length + partOverheadBytes,
        partOverheadBytes,
      ),
  });
/** What reading saved transcripts needs: the store and the host's cache of built ones. */
export type EntryReader = { harness: Harness; entryTranscripts: EntryTranscriptCache };

export const getEntryTranscript = (
  { harness, entryTranscripts }: EntryReader,
  entry: EntryRecord,
): Effect.Effect<EntryTranscript, ChatError> =>
  Effect.gen(function* () {
    const cached = entryTranscripts.get(String(entry.id));
    if (cached) return cached;
    const pairing = (yield* getPairing(harness, entry)) ?? { pairing: 'unmatched' as const };
    const diagnostics = ToolResultEntry.is(entry) ? (entry.data?.diagnostics ?? []) : [];
    const interrupted = diagnostics.some(
      (item) => item.code === 'aborted' || item.code === 'interrupted',
    );
    const parts: Part[] = [];
    for (const { part } of getEntryTextValues(entry)) {
      if (!part) continue;
      const built = makeValuePart(part);
      if (built.role === 'tool')
        built.extra = {
          ...built.extra,
          ...pairing,
          ...(interrupted ? { state: 'interrupted' as const } : {}),
        };
      parts.push(built);
      if (parts.length % partsPerTurn === 0) yield* Effect.yieldNow;
    }
    const transcript = {
      conversationId: entry.conversationId,
      parts,
      thinking: summarizeThinking(parts),
    };
    entryTranscripts.set(String(entry.id), transcript);
    return transcript;
  });
/** Reads a saved entry's transcript, loading the record only when it is not cached. */
export const readSavedTranscript = (reader: EntryReader, target: ChatTarget, entryId: string) =>
  Effect.gen(function* () {
    const cached = reader.entryTranscripts.get(String(yield* runCheck(() => eid(entryId))));
    if (!cached)
      return yield* getEntryTranscript(reader, yield* readEntry(reader.harness, target, entryId));
    if (cached.conversationId !== (yield* runCheck(() => cid(target.conversationId))))
      return yield* new InvalidChatRequestError({ problem: 'entry' });
    return cached;
  });
