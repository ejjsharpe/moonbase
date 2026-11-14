import type {
  ChatEntry,
  ChatOutput,
  ChatSnapshot,
  ChatTranscriptPart,
  ChatTranscriptSource,
} from '@moonbase/contracts/chat';
import { areJsonValuesEqual } from '@moonbase/contracts/common';
import { makeTranscriptFailure } from './transcript-read.ts';
import type { TranscriptManifestState } from './transcript-state.ts';
import { reuseParts } from './transcript-history.ts';

type ManifestReply = Extract<ChatOutput<'getChatTranscriptContent'>, { kind: 'manifest' }>;

export const makeManifest = (source: ChatTranscriptSource): TranscriptManifestState => ({
  source,
  parts: [],
  nextCursor: null,
  omittedParts: 0,
  status: 'partial',
  error: null,
});

/** Appends a continuation page, reusing part values the summaries already hold. */
export function appendManifestPage(
  manifest: TranscriptManifestState,
  reply: ManifestReply,
  known: ChatTranscriptPart[],
): TranscriptManifestState {
  if (reply.parts.some((part) => manifest.parts.some((old) => old.partId === part.partId)))
    throw makeTranscriptFailure('Manifest continuation repeats a part.');
  return {
    ...manifest,
    parts: [...manifest.parts, ...reuseParts(known, reply.parts)],
    nextCursor: reply.nextCursor,
    status: reply.nextCursor ? 'partial' : 'complete',
    error: null,
  };
}

/** Finds the summary parts for a source: the live run's, or a retained entry's. */
export function findKnownParts(
  source: ChatTranscriptSource,
  snapshot: ChatSnapshot | undefined,
  records: ChatEntry[],
) {
  if (snapshot?.run?.transcript && areJsonValuesEqual(snapshot.run.transcript.source, source))
    return snapshot.run.transcript.parts;
  return (
    records.find((entry) => areJsonValuesEqual(entry.transcript.source, source))?.transcript
      .parts ?? []
  );
}

/** Whether an accepted snapshot changed the manifest's source summary. */
export function isManifestChanged(
  manifest: TranscriptManifestState,
  old: ChatSnapshot | undefined,
  next: { entries: ChatEntry[]; run: ChatSnapshot['run'] },
) {
  if (manifest.source.kind === 'live')
    return !!old?.run?.transcript && !areJsonValuesEqual(old.run.transcript, next.run?.transcript);
  const entryId = manifest.source.entryId;
  const previous = old?.entries.find((entry) => entry.id === entryId)?.transcript;
  const current = next.entries.find((entry) => entry.id === entryId)?.transcript;
  return !!previous && !!current && !areJsonValuesEqual(previous, current);
}
