import type { EntryRecord, Harness } from '@earendil-works/pi-durable';
import {
  chatLiveTextBytes,
  type ChatTarget,
  type ChatTranscript,
  type ChatTranscriptPart,
  type ChatTranscriptSource,
} from '@moonbase/contracts/chat';
import { TranscriptChangedError } from '@moonbase/contracts/chat-errors';
import { writeCursor } from '../cursors.ts';
import { hashJson } from '../hash-json.ts';
import { getEntryTranscript } from './entry-transcript.ts';
import type { TranscriptCapture } from './live-capture.ts';
import { getLiveTranscript } from './live-transcript.ts';
import { describePart, giveWholeText, type Part, type TranscriptParts } from './transcript-part.ts';

/** History and live snapshots embed only the first manifest page of each transcript. */
const embeddedManifestParts = 4;
/**
 * A manifest cursor binds the ordered part IDs and kinds before its position, so values may grow
 * and later parts may appear without invalidating it; per-selection revisions cover content.
 */
export async function projectManifest(
  source: ChatTranscriptSource,
  transcript: TranscriptParts,
  start: number,
  limit: number,
  revision?: string,
  /** A running response's page carries its text parts whole within this many bytes of text. */
  wholeTextBytes?: number,
): Promise<ChatTranscript> {
  const seen: [string, ChatTranscriptPart['kind']][] = [];
  const page: ChatTranscriptPart[] = [];
  const pageParts: Part[] = [];
  let more = false;
  for await (const part of transcript.parts) {
    if (seen.length === start + limit) {
      more = true;
      break;
    }
    if (seen.length >= start) {
      page.push(describePart(part));
      pageParts.push(part);
    }
    seen.push([part.id, part.kind]);
  }
  if (wholeTextBytes !== undefined) giveWholeText(page, pageParts, wholeTextBytes);
  if (
    revision !== undefined &&
    (seen.length < start || hashJson(seen.slice(0, start)) !== revision)
  )
    throw new TranscriptChangedError({ change: 'manifest' });
  return {
    source,
    parts: page,
    nextCursor: more
      ? writeCursor({
          kind: 'manifest',
          binding: hashJson(source),
          revision: hashJson(seen),
          position: seen.length,
        })
      : null,
    thinking: transcript.thinking,
  };
}
export async function projectEntryTranscript(
  harness: Harness,
  target: ChatTarget,
  entry: EntryRecord,
  signal?: AbortSignal,
) {
  const source: ChatTranscriptSource = { kind: 'entry', target, entryId: String(entry.id) };
  return projectManifest(
    source,
    await getEntryTranscript(harness, entry, signal),
    0,
    embeddedManifestParts,
  );
}
export async function projectLiveTranscript(
  harness: Harness,
  source: ChatTranscriptSource,
  captured: TranscriptCapture,
) {
  return projectManifest(
    source,
    await getLiveTranscript(harness, source, { capture: captured }),
    0,
    embeddedManifestParts,
    undefined,
    chatLiveTextBytes,
  );
}
