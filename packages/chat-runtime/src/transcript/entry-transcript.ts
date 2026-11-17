import { setImmediate } from 'node:timers/promises';
import { ToolResultEntry, type EntryRecord, type Harness } from '@earendil-works/pi-durable';
import { LRUCache } from 'lru-cache';
import type { ChatTarget, ChatTranscript } from '@moonbase/contracts/chat';
import { InvalidChatRequestError } from '@moonbase/contracts/chat-errors';
import { cid, eid } from '../documents.ts';
import { getEntryTextValues } from './message-values.ts';
import { readEntry } from './saved-entries.ts';
import { getPairing } from './tool-pairing.ts';
import { makeValuePart, partsPerTurn, summarizeThinking, type Part } from './transcript-part.ts';

/** Saved entries are immutable, so each Harness shares their built parts up to this budget. */
const entryCacheBytes = 32 * 1024 * 1024;
const partOverheadBytes = 512;
type EntryTranscript = {
  /** Saved entries never move, so a cached transcript can authorize its own reads. */
  conversationId: EntryRecord['conversationId'];
  parts: Part[];
  thinking: ChatTranscript['thinking'];
};
const entryTranscripts = new WeakMap<Harness, LRUCache<string, EntryTranscript>>();
function getEntryCache(harness: Harness) {
  let cache = entryTranscripts.get(harness);
  if (!cache) {
    cache = new LRUCache<string, EntryTranscript>({
      maxSize: entryCacheBytes,
      // Parts are immutable once built, so this size never changes after insertion.
      sizeCalculation: (transcript) =>
        transcript.parts.reduce(
          (size, part) => size + part.value.length + partOverheadBytes,
          partOverheadBytes,
        ),
    });
    entryTranscripts.set(harness, cache);
  }
  return cache;
}
export async function getEntryTranscript(
  harness: Harness,
  entry: EntryRecord,
  signal?: AbortSignal,
): Promise<EntryTranscript> {
  const cache = getEntryCache(harness);
  const cached = cache.get(String(entry.id));
  if (cached) return cached;
  signal?.throwIfAborted();
  const pairing = (await getPairing(harness, entry, signal)) ?? { pairing: 'unmatched' as const };
  signal?.throwIfAborted();
  const diagnostics = ToolResultEntry.is(entry) ? (entry.data?.diagnostics ?? []) : [];
  const interrupted = diagnostics.some(
    (item) => item.code === 'aborted' || item.code === 'interrupted',
  );
  const parts: Part[] = [];
  for (const { part } of getEntryTextValues(entry)) {
    if (!part) continue;
    signal?.throwIfAborted();
    const built = makeValuePart(part);
    if (built.role === 'tool')
      built.extra = {
        ...built.extra,
        ...pairing,
        ...(interrupted ? { state: 'interrupted' as const } : {}),
      };
    parts.push(built);
    if (signal && parts.length % partsPerTurn === 0) await setImmediate();
  }
  const transcript = {
    conversationId: entry.conversationId,
    parts,
    thinking: summarizeThinking(parts),
  };
  cache.set(String(entry.id), transcript);
  return transcript;
}
/** Reads a saved entry's transcript, loading the record only when it is not cached. */
export async function readSavedTranscript(
  harness: Harness,
  target: ChatTarget,
  entryId: string,
  signal?: AbortSignal,
) {
  const cached = getEntryCache(harness).get(String(eid(entryId)));
  if (!cached)
    return getEntryTranscript(harness, await readEntry(harness, target, entryId), signal);
  if (cached.conversationId !== cid(target.conversationId))
    throw new InvalidChatRequestError({ problem: 'entry' });
  return cached;
}
