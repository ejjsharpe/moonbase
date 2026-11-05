import type { ChatEntry, ChatTranscript, ChatTranscriptPart } from '@moonbase/contracts/chat';
import { structuredSourceLimits } from './source-limits.ts';

function isActivityPart(part: ChatTranscriptPart) {
  return (
    part.kind === 'thinking' ||
    part.role === 'tool' ||
    ['arguments', 'executed-arguments', 'patch', 'diff', 'details', 'result'].includes(part.kind) ||
    (part.kind === 'notice' && !!part.toolName)
  );
}

/** Only consecutive activity folds; authored answers keep their recorded position. */
export function groupTranscriptParts(parts: ChatTranscriptPart[]) {
  const groups: { activity: boolean; parts: ChatTranscriptPart[] }[] = [];
  for (const part of parts) {
    const activity = isActivityPart(part),
      previous = groups.at(-1);
    if (activity && previous?.activity) previous.parts.push(part);
    else groups.push({ activity, parts: [part] });
  }
  return groups;
}

export type ActivityEvidence = Map<string, ChatTranscriptPart[]>;
const callKey = (transcript: Pick<ChatTranscript, 'source'>, entryId: string, partId: string) =>
  JSON.stringify([transcript.source.target, entryId, partId]);

export function collectActivityEvidence(
  transcripts: Pick<ChatTranscript, 'source' | 'parts'>[],
): ActivityEvidence {
  const evidence: ActivityEvidence = new Map();
  for (const transcript of transcripts)
    for (const part of transcript.parts) {
      if (!part.call || part.pairing !== 'matched') continue;
      const key = callKey(transcript, part.call.entryId, part.call.partId);
      const recorded = evidence.get(key) ?? [];
      recorded.push(part);
      evidence.set(key, recorded);
    }
  return evidence;
}

export function getActivityState(
  part: ChatTranscriptPart,
  transcript: Pick<ChatTranscript, 'source'>,
  evidence: ActivityEvidence,
) {
  const recorded =
    part.kind === 'arguments' && transcript.source.kind === 'entry'
      ? (evidence.get(callKey(transcript, transcript.source.entryId, part.partId)) ?? [])
      : [];
  const states = [...recorded, part].map((item) => item.state);
  return ['failed', 'interrupted', 'missing-result', 'running', 'completed', 'requested'].find(
    (state) => states.includes(state as ChatTranscriptPart['state']),
  );
}

/** Activity reads only recorded states, so evidence with the same states is interchangeable. */
export function isSameActivityEvidence(a: ActivityEvidence, b: ActivityEvidence) {
  if (a.size !== b.size) return false;
  for (const [key, parts] of a) {
    const other = b.get(key);
    if (other?.length !== parts.length || parts.some((part, i) => part.state !== other[i]!.state))
      return false;
  }
  return true;
}

/** Characters of a running or failed result's progress shown in a folded summary. */
const progressExcerptUnits = 100;

/** Folded Activity still shows each part's state, and a running or failed result's progress. */
export function describeActivityPart(
  part: ChatTranscriptPart,
  transcript: Pick<ChatTranscript, 'source'>,
  evidence: ActivityEvidence,
) {
  const status = getActivityState(part, transcript, evidence);
  if (part.kind === 'thinking') {
    const details = ['Thinking', part.availability];
    if (status && status !== 'completed') details.push(status);
    if (part.availability === 'available') details.push(`${part.bytes.toLocaleString()} bytes`);
    return details.join(' · ');
  }
  const details = [getToolSummary(part)];
  if (status) details.push(status === 'requested' ? 'requested · result not shown' : status);
  if (part.pairing && part.pairing !== 'matched') details.push(part.pairing);
  if (part.kind === 'result') {
    details.push(`${part.bytes.toLocaleString()} bytes`);
    if (['running', 'failed', 'interrupted'].includes(status ?? '') && part.text)
      details.push(
        part.text.replace(/\s+/g, ' ').slice(0, progressExcerptUnits) + (part.truncated ? '…' : ''),
      );
  }
  return details.join(' · ');
}

export function getToolSummary(part: ChatTranscriptPart, text = part.text) {
  const name = part.toolName ?? 'Tool';
  if (
    !['arguments', 'executed-arguments'].includes(part.kind) ||
    text.length > structuredSourceLimits.units
  )
    return name;
  try {
    const args: unknown = JSON.parse(text);
    if (!args || typeof args !== 'object' || Array.isArray(args)) return name;
    const values = args as Record<string, unknown>;
    let value: unknown;
    if (['read', 'write', 'edit'].includes(name)) value = values.path ?? values.file_path;
    else if (name === 'bash') value = values.command;
    if (typeof value !== 'string') return name;
    return `${name} · ${value.replace(/\s+/g, ' ').slice(0, 160)}`;
  } catch {
    return name;
  }
}

export function getEntryTranscripts(
  entries: ChatEntry[],
  manifest: Pick<ChatTranscript, 'source' | 'parts'> | null,
) {
  return entries.flatMap((entry) =>
    entry.transcript
      ? [
          manifest?.parts.length &&
          JSON.stringify(manifest.source) === JSON.stringify(entry.transcript.source)
            ? manifest
            : entry.transcript,
        ]
      : [],
  );
}
