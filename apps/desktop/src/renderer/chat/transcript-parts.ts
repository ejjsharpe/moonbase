import type { TranscriptManifestState } from '@moonbase/application/chat';
import type { ChatTranscript } from '@moonbase/contracts/chat';

export function getTranscriptParts(
  transcript: Pick<ChatTranscript, 'source' | 'parts'>,
  manifest: Pick<TranscriptManifestState, 'source' | 'parts' | 'status'> | null,
) {
  if (
    !manifest?.parts.length ||
    JSON.stringify(manifest.source) !== JSON.stringify(transcript.source)
  )
    return transcript.parts;
  if (transcript.source.kind !== 'live' || manifest.status !== 'source-changed')
    return manifest.parts;
  // Snapshot parts are the ordered prefix; opaque part IDs do not encode order.
  const current = new Set(transcript.parts.map((part) => part.partId));
  return [...transcript.parts, ...manifest.parts.filter((part) => !current.has(part.partId))];
}
