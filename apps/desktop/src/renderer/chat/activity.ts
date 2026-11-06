import type { ChatEntry, ChatTranscript, ChatTranscriptPart } from '@moonbase/contracts/chat';
import { areJsonValuesEqual } from '@moonbase/contracts/common';
import { structuredSourceLimits } from './source-limits.ts';

export function isActivityPart(part: ChatTranscriptPart) {
  return (
    part.kind === 'thinking' ||
    part.role === 'tool' ||
    ['arguments', 'executed-arguments', 'patch', 'diff', 'details', 'result'].includes(part.kind) ||
    (part.kind === 'notice' && !!part.toolName)
  );
}

/**
 * How an entry reads in the transcript. Pi records each tool call, result and turn marker as its
 * own entry: an empty marker takes no space, and calls and results read as activity, which
 * consecutive rows join into one card.
 */
export function classifyEntry(entry: ChatEntry): 'empty' | 'activity' | 'message' {
  const parts = entry.transcript?.parts ?? [];
  if (
    entry.role === 'system' &&
    !entry.text.trim() &&
    parts.every((part) => part.kind === 'text' && part.bytes === 0)
  )
    return 'empty';
  if (entry.role === 'tool') return 'activity';
  if (
    entry.role === 'assistant' &&
    !entry.text.trim() &&
    parts.length &&
    parts.every(isActivityPart)
  )
    return 'activity';
  return 'message';
}

/** Space above each row, and whether an activity row joins the activity card beside it. */
export type RowSpacing = { gap: number; joinPrevious: boolean; joinNext: boolean };
export function getRowSpacing(
  rows: readonly ({ key: string } & ({ entry: ChatEntry } | { tool: unknown }))[],
  gap: number,
) {
  const spacing = new Map<string, RowSpacing>();
  let previous: { key: string; activity: boolean } | null = null;
  for (const row of rows) {
    const kind = 'entry' in row ? classifyEntry(row.entry) : 'message';
    if (kind === 'empty') {
      spacing.set(row.key, { gap: 0, joinPrevious: false, joinNext: false });
      continue;
    }
    const activity = kind === 'activity',
      join = activity && !!previous?.activity;
    if (join) spacing.get(previous!.key)!.joinNext = true;
    spacing.set(row.key, { gap: previous && !join ? gap : 0, joinPrevious: join, joinNext: false });
    previous = { key: row.key, activity };
  }
  return spacing;
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
  // A completed step's ✓ already says so.
  const details = [getToolSummary(part)];
  if (status && status !== 'completed')
    details.push(status === 'requested' ? 'requested · result not shown' : status);
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

/** A tool call with the parts that answer it in the same group, shown as one step. */
export type ActivityStep = { lead: ChatTranscriptPart; answers: ChatTranscriptPart[] };

/** Pairs each part with the call it answers when that call is in the same group. */
export function groupActivitySteps(parts: readonly ChatTranscriptPart[]) {
  const steps: ActivityStep[] = [],
    calls = new Map<string, ActivityStep>();
  for (const part of parts) {
    const call = part.call && calls.get(part.call.partId);
    if (call) call.answers.push(part);
    else {
      const step = { lead: part, answers: [] };
      steps.push(step);
      if (part.kind === 'arguments') calls.set(part.partId, step);
    }
  }
  return steps;
}

/** A step reads as its call; answered steps add the result's size and any failure progress. */
export function describeActivityStep(
  step: ActivityStep,
  transcript: Pick<ChatTranscript, 'source'>,
  evidence: ActivityEvidence,
) {
  const details = [describeActivityPart(step.lead, transcript, evidence)];
  for (const answer of step.answers) {
    if (answer.kind !== 'result') continue;
    const status = getActivityState(answer, transcript, evidence);
    details.push(`${answer.bytes.toLocaleString()} bytes`);
    if (['running', 'failed', 'interrupted'].includes(status ?? '') && answer.text)
      details.push(
        answer.text.replace(/\s+/g, ' ').slice(0, progressExcerptUnits) +
          (answer.truncated ? '…' : ''),
      );
  }
  return details.join(' · ');
}

/** The state that marks a step: its call's, unless an answer in the step failed or still runs. */
export function getActivityStepState(
  step: ActivityStep,
  transcript: Pick<ChatTranscript, 'source'>,
  evidence: ActivityEvidence,
) {
  const states = [step.lead, ...step.answers].map((part) =>
    getActivityState(part, transcript, evidence),
  );
  return ['failed', 'interrupted', 'missing-result', 'running', 'completed', 'requested'].find(
    (state) => states.includes(state),
  );
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
          manifest?.parts.length && areJsonValuesEqual(manifest.source, entry.transcript.source)
            ? manifest
            : entry.transcript,
        ]
      : [],
  );
}
