import type { ChatEntry, ChatTranscript, ChatTranscriptPart } from '@moonbase/contracts/chat';
import { areJsonValuesEqual } from '@moonbase/contracts/common';
import { structuredSourceLimits } from './source-limits.ts';
import { parseRecordedPatch } from './recorded-patch.ts';

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

/**
 * The list's items: each row on its own, except that empty turn markers are left out and a run of
 * consecutive activity rows is one item, so the list's gap never splits a turn's card. Items whose
 * rows are unchanged keep their identity.
 *
 * The list keys an item's content and measured size by the item's key, so a new key remounts the
 * card. Rows join a run at its start (history loading above) and its end (the live response, a
 * later page), and the live row leaves it when the answer starts. So a run holding a row of a
 * `previous` item keeps that item's key; when an item splits, the first run keeps it. Otherwise an
 * item is keyed by its last row. Keys are list keys only: `findReadingAnchor` names a row.
 */
export type TranscriptItem<Row> = { key: string; rows: readonly Row[] };
export function groupTranscriptRows<Row extends { key: string }>(
  rows: readonly Row[],
  kindOf: (row: Row) => 'empty' | 'activity' | 'message',
  previous: readonly TranscriptItem<Row>[],
) {
  const runs: Row[][] = [];
  let open = false;
  for (const row of rows) {
    const kind = kindOf(row);
    if (kind === 'empty') continue;
    if (kind === 'activity' && open) runs.at(-1)!.push(row);
    else runs.push([row]);
    open = kind === 'activity';
  }
  const itemOf = new Map(previous.flatMap((item) => item.rows.map((row) => [row.key, item])));
  const claimed = new Set<string>();
  const carried = runs.map((run) => {
    for (const row of run) {
      const old = itemOf.get(row.key);
      if (old && !claimed.has(old.key)) {
        claimed.add(old.key);
        return old;
      }
    }
    return undefined;
  });
  return runs.map((run, index): TranscriptItem<Row> => {
    const old = carried[index];
    if (old?.rows.length === run.length && old.rows.every((row, i) => row === run[i])) return old;
    let key = old?.key ?? run.at(-1)!.key;
    // A row's key can name another run's carried key, so a new key must be unclaimed.
    for (let suffix = 1; !old && claimed.has(key); suffix++) key = `${run.at(-1)!.key}#${suffix}`;
    claimed.add(key);
    return { key, rows: run };
  });
}

/**
 * The reading anchor for the list's first visible item, `{key, offset}` from its top: the item's
 * last stored row, so a card whose last row is the live response doesn't read as following the
 * live edge. An item of live rows alone anchors to the nearest earlier stored row, at its offset
 * from that row's item (`measure`); with none before it, it names its own row.
 */
export function findReadingAnchor<Row extends { key: string; kind: string }>(
  items: readonly TranscriptItem<Row>[],
  visible: { key: string; offset: number },
  measure: (itemKey: string) => number | undefined,
) {
  const index = items.findIndex((item) => item.key === visible.key);
  if (index < 0) return undefined;
  for (let i = index; i >= 0; i--) {
    const row = items[i]!.rows.findLast((row) => row.kind === 'entry');
    if (!row) continue;
    const offset = i === index ? visible.offset : measure(items[i]!.key);
    return offset === undefined ? undefined : { key: row.key, offset };
  }
  return { key: items[index]!.rows[0]!.key, offset: visible.offset };
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

/** Characters of output or thought shown in a folded summary. */
const progressExcerptUnits = 100;

/** The start of recorded text on one line, as a step's glimpse of what came back. */
function excerpt(part: ChatTranscriptPart) {
  const text = part.text.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const cut = text.length > progressExcerptUnits || part.truncated;
  return text.slice(0, progressExcerptUnits) + (cut ? '…' : '');
}

/** Folded Activity shows each part's state, and the start of what a result or thought holds. */
export function describeActivityPart(
  part: ChatTranscriptPart,
  transcript: Pick<ChatTranscript, 'source'>,
  evidence: ActivityEvidence,
) {
  const status = getActivityState(part, transcript, evidence);
  if (part.kind === 'thinking') {
    // Only an unusual availability (redacted, withheld) is worth saying.
    const details = ['Thinking'];
    if (part.availability !== 'available') details.push(part.availability);
    if (status && status !== 'completed') details.push(status);
    if (part.availability === 'available' && excerpt(part)) details.push(excerpt(part));
    return details.join(' · ');
  }
  // A completed step's ✓ already says so.
  const details = [getToolSummary(part)];
  if (status && status !== 'completed')
    details.push(status === 'requested' ? 'requested · result not shown' : status);
  if (part.pairing && part.pairing !== 'matched') details.push(part.pairing);
  if (part.kind === 'result') details.push(excerpt(part) || 'no output');
  return details.join(' · ');
}

/** A tool call with the parts that answer it in the same group, shown as one step. */
export type ActivityStep = { lead: ChatTranscriptPart; answers: ChatTranscriptPart[] };

/**
 * Pairs each part with the call it answers: the call itself when it is in this group (from the
 * row's own entry), else the first answer to the same call here, so an edit's output, details,
 * patch and diff read as one step.
 */
export function groupActivitySteps(parts: readonly ChatTranscriptPart[], entryId?: string) {
  const steps: ActivityStep[] = [],
    calls = new Map<string, ActivityStep>(),
    answered = new Map<string, ActivityStep>();
  for (const part of parts) {
    const key = part.call && `${part.call.entryId}\n${part.call.partId}`;
    const owner =
      part.call &&
      ((part.call.entryId === entryId ? calls.get(part.call.partId) : undefined) ??
        answered.get(key!));
    if (owner) owner.answers.push(part);
    else {
      const step: ActivityStep = { lead: part, answers: [] };
      steps.push(step);
      if (part.kind === 'arguments') calls.set(part.partId, step);
      if (key) answered.set(key, step);
    }
  }
  return steps;
}

/** Added and removed lines in a complete recorded patch or diff. */
function countPatchLines(part: ChatTranscriptPart) {
  if (part.truncated || !part.text) return '';
  const parsed = parseRecordedPatch(part.text);
  if (!('files' in parsed)) return '';
  let added = 0,
    removed = 0;
  for (const file of parsed.files)
    for (const hunk of file.hunks)
      for (const line of hunk.lines) {
        if (line.kind === 'added') added++;
        if (line.kind === 'removed') removed++;
      }
  return added || removed ? `+${added} −${removed}` : '';
}

/**
 * A step reads as its lead part. Answers add a recorded patch's line counts, and a later output's
 * failure or running progress.
 */
export function describeActivityStep(
  step: ActivityStep,
  transcript: Pick<ChatTranscript, 'source'>,
  evidence: ActivityEvidence,
) {
  const details = [describeActivityPart(step.lead, transcript, evidence)];
  const changes = [step.lead, ...step.answers]
    .filter((part) => part.kind === 'patch' || part.kind === 'diff')
    .map(countPatchLines)
    .find(Boolean);
  if (changes) details.push(changes);
  for (const answer of step.answers) {
    const status = getActivityState(answer, transcript, evidence);
    if (answer.kind === 'result' && ['running', 'failed', 'interrupted'].includes(status ?? ''))
      details.push(excerpt(answer));
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
  let keys: string[] = [];
  if (['read', 'write', 'edit'].includes(name)) keys = ['path', 'file_path'];
  else if (name === 'bash') keys = ['command'];
  let value: unknown;
  try {
    const args: unknown = JSON.parse(text);
    if (!args || typeof args !== 'object' || Array.isArray(args)) return name;
    const values = args as Record<string, unknown>;
    value = keys.map((key) => values[key]).find((item) => item !== undefined);
  } catch {
    // A preview cut short of its JSON still names a leading path or command.
    for (const key of keys) {
      const found = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
      if (found) {
        try {
          value = JSON.parse(`"${found[1]}"`);
        } catch {
          value = found[1];
        }
        break;
      }
    }
  }
  if (typeof value !== 'string') return name;
  return `${name} · ${value.replace(/\s+/g, ' ').slice(0, 160)}`;
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
