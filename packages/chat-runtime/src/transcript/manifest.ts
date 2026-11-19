import type { EntryRecord } from '@earendil-works/pi-durable';
import { Effect, Stream } from 'effect';
import {
  chatLiveTextBytes,
  type ChatTarget,
  type ChatTranscript,
  type ChatTranscriptPart,
  type ChatTranscriptSource,
} from '@moonbase/contracts/chat';
import { TranscriptChangedError, type ChatError } from '@moonbase/contracts/chat-errors';
import { writeCursor } from '../cursors.ts';
import { hashJson } from '../hash-json.ts';
import { getEntryTranscript, type EntryReader, type EntryTranscript } from './entry-transcript.ts';
import type { TranscriptCapture } from './live-capture.ts';
import { getLiveTranscript } from './live-transcript.ts';
import { describePart, giveWholeText, type Part, type TranscriptParts } from './transcript-part.ts';

/** History and live snapshots embed only the first manifest page of each transcript. */
const embeddedManifestParts = 4;
/**
 * A manifest cursor binds the ordered part IDs and kinds before its position, so values may grow
 * and later parts may appear without invalidating it; per-selection revisions cover content.
 */
export const projectManifest = (
  source: ChatTranscriptSource,
  transcript: TranscriptParts,
  start: number,
  limit: number,
  revision?: string,
  /** A running response's page carries its text parts whole within this many bytes of text. */
  wholeTextBytes?: number,
): Effect.Effect<ChatTranscript, ChatError> =>
  Effect.gen(function* () {
    const seen: [string, ChatTranscriptPart['kind']][] = [];
    const page: ChatTranscriptPart[] = [];
    const pageParts: Part[] = [];
    let more = false;
    // One part past the page says whether there is another.
    yield* transcript.parts.pipe(
      Stream.take(start + limit + 1),
      Stream.runForEach((part) =>
        Effect.sync(() => {
          if (seen.length === start + limit) {
            more = true;
            return;
          }
          if (seen.length >= start) {
            page.push(describePart(part));
            pageParts.push(part);
          }
          seen.push([part.id, part.kind]);
        }),
      ),
    );
    if (wholeTextBytes !== undefined) giveWholeText(page, pageParts, wholeTextBytes);
    if (
      revision !== undefined &&
      (seen.length < start || hashJson(seen.slice(0, start)) !== revision)
    )
      return yield* new TranscriptChangedError({ change: 'manifest' });
    return {
      source,
      parts: page,
      nextCursor: more
        ? yield* writeCursor({
            kind: 'manifest',
            binding: hashJson(source),
            revision: hashJson(seen),
            position: seen.length,
          })
        : null,
      thinking: transcript.thinking,
    };
  });
/** The parts of a saved entry's transcript, as a reader of any transcript takes them. */
export const listEntryParts = (transcript: EntryTranscript): TranscriptParts => ({
  parts: Stream.fromIterable(transcript.parts),
  thinking: transcript.thinking,
});
export const projectEntryTranscript = (
  reader: EntryReader,
  target: ChatTarget,
  entry: EntryRecord,
) =>
  Effect.flatMap(getEntryTranscript(reader, entry), (transcript) =>
    projectManifest(
      { kind: 'entry', target, entryId: String(entry.id) },
      listEntryParts(transcript),
      0,
      embeddedManifestParts,
    ),
  );
export const projectLiveTranscript = (
  reader: EntryReader,
  source: ChatTranscriptSource,
  captured: TranscriptCapture,
) =>
  Effect.flatMap(getLiveTranscript(reader, source, captured), (transcript) =>
    projectManifest(source, transcript, 0, embeddedManifestParts, undefined, chatLiveTextBytes),
  );
