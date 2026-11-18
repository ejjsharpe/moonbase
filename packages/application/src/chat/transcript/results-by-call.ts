import type {
  ChatTranscript,
  ChatTranscriptPart,
  ChatTranscriptSource,
} from '@moonbase/contracts/chat';
import { areJsonValuesEqual } from '@moonbase/contracts/common';
import type { TranscriptManifestState, TranscriptState } from './transcript-state.ts';

/**
 * The parts a transcript shows: its own, or the loaded manifest's when that describes the same
 * source. A live source that changed keeps its snapshot parts (the current prefix) and adds the
 * manifest's others after them, since part IDs do not encode order.
 */
export function getTranscriptParts(
  transcript: Pick<ChatTranscript, 'source' | 'parts'>,
  manifest: Pick<TranscriptManifestState, 'source' | 'parts' | 'status'> | null,
) {
  if (!manifest?.parts.length || !areJsonValuesEqual(manifest.source, transcript.source))
    return transcript.parts;
  if (transcript.source.kind !== 'live' || manifest.status !== 'source-changed')
    return manifest.parts;
  const current = new Set(transcript.parts.map((part) => part.partId));
  return [...transcript.parts, ...manifest.parts.filter((part) => !current.has(part.partId))];
}

/**
 * Each tool call's matched results, keyed by `getCallKey`. A call and its output are separate
 * entries, so a call's state reads from the results recorded in other rows.
 */
export type ResultsByCall = ReadonlyMap<string, readonly ChatTranscriptPart[]>;

/** The key of the call `partId` in `entryId`, in the chat `source` belongs to. */
export const getCallKey = (
  source: Pick<ChatTranscriptSource, 'target'>,
  entryId: string,
  partId: string,
) => JSON.stringify([source.target, entryId, partId]);

/** Collects each call's matched results from `transcripts`. */
export function collectResultsByCall(
  transcripts: readonly Pick<ChatTranscript, 'source' | 'parts'>[],
): ResultsByCall {
  const results = new Map<string, ChatTranscriptPart[]>();
  for (const transcript of transcripts)
    for (const part of transcript.parts) {
      if (!part.call || part.pairing !== 'matched') continue;
      const key = getCallKey(transcript.source, part.call.entryId, part.call.partId);
      const recorded = results.get(key) ?? [];
      recorded.push(part);
      results.set(key, recorded);
    }
  return results;
}

/** The retained entries' transcripts and the running response's, each with its shown parts. */
export function listShownTranscripts(
  state: Pick<TranscriptState, 'entries' | 'rows' | 'manifest'>,
): Pick<ChatTranscript, 'source' | 'parts'>[] {
  const { manifest } = state;
  const stored = state.entries.map((entry) =>
    manifest?.parts.length && areJsonValuesEqual(manifest.source, entry.transcript.source)
      ? manifest
      : entry.transcript,
  );
  // The running response is the last row.
  const last = state.rows.at(-1);
  const live = last?.kind === 'live' ? last.entry.transcript : undefined;
  return live ? [...stored, { ...live, parts: getTranscriptParts(live, manifest) }] : stored;
}

/** Results are read only for their states, so results with the same states are the same. */
export function isSameResultsByCall(a: ResultsByCall, b: ResultsByCall) {
  if (a.size !== b.size) return false;
  for (const [key, parts] of a) {
    const other = b.get(key);
    if (other?.length !== parts.length || parts.some((part, i) => part.state !== other[i]!.state))
      return false;
  }
  return true;
}
