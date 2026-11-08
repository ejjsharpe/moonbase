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
 * consecutive activity rows is one item, so the list's gap never splits a turn's card. An item's
 * key is its last row's. Items whose rows are unchanged keep their identity.
 */
export type TranscriptItem<Row> = { key: string; rows: readonly Row[] };
export function groupTranscriptRows<Row extends { key: string }>(
  rows: readonly Row[],
  kindOf: (row: Row) => 'empty' | 'activity' | 'message',
  previous: WeakMap<Row, TranscriptItem<Row>>,
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
  return runs.map((run) => {
    // Keyed by its last row: history loading above can join rows to a run's start, and its key
    // must not change under the reader.
    const last = run.at(-1)!;
    const old = previous.get(last);
    if (old && old.rows.length === run.length && old.rows.every((row, i) => row === run[i]))
      return old;
    const item = { key: last.key, rows: run };
    previous.set(last, item);
    return item;
  });
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

/**
 * The words a state adds to its glyph. Completed (✓), running (spinner) and requested (○) need
 * none; a failure is worth saying in words.
 */
export function describeActivityState(state: string | undefined) {
  if (!state || ['completed', 'running', 'requested'].includes(state)) return undefined;
  return state === 'missing-result' ? 'no result' : state;
}

/** Folded Activity shows each part's state, and the start of what a result or thought holds. */
export function describeActivityPart(
  part: ChatTranscriptPart,
  transcript: Pick<ChatTranscript, 'source'>,
  evidence: ActivityEvidence,
) {
  const status = describeActivityState(getActivityState(part, transcript, evidence));
  if (part.kind === 'thinking') {
    // Only an unusual availability (redacted, withheld) is worth saying.
    const details = ['Thinking'];
    if (part.availability !== 'available') details.push(part.availability);
    if (status) details.push(status);
    if (part.availability === 'available' && excerpt(part)) details.push(excerpt(part));
    return details.join(' · ');
  }
  const details = [getToolSummary(part)];
  if (status) details.push(status);
  // "no output" would only repeat a missing result.
  if (part.kind === 'result' && (excerpt(part) || status !== 'no result'))
    details.push(excerpt(part) || 'no output');
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

/** A step as the reader sees it: what it did, what it did it to, and a word only for trouble. */
export type ActivityHeadline = {
  /** Which counter the step adds to in a folded summary. */
  category: 'thinking' | 'read' | 'edit' | 'command' | 'tool';
  /** A verb phrase in the tense of the step's state: "Running npm", "Read logger.ts". */
  action: string;
  /** What the action touched, in full: a command line, a path, line counts. */
  detail: string;
  /** Set for a failure, interruption or missing result. */
  problem?: string;
  /** For an edit or write, the file, so a summary counts files rather than calls. */
  path?: string;
};

const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** The tool's main argument (a command or a path) from a call's recorded JSON. */
function getToolArgument(part: ChatTranscriptPart, keys: string[]) {
  if (!['arguments', 'executed-arguments'].includes(part.kind)) return undefined;
  try {
    const args: unknown = JSON.parse(part.text);
    if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
    const value = keys.map((key) => (args as Record<string, unknown>)[key]).find(Boolean);
    return typeof value === 'string' ? value : undefined;
  } catch {
    // A preview cut short of its JSON still names a leading path or command.
    for (const key of keys) {
      const found = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(part.text);
      if (found) return found[1]!.replace(/\\(.)/g, '$1');
    }
    return undefined;
  }
}

/**
 * The program a shell line runs, past `cd` hops, variable assignments and wrappers, and the rest of
 * the line after it.
 */
export function splitCommand(command: string) {
  const separators = /&&|\|\||;|\|/g;
  let from = 0;
  for (const match of [...command.matchAll(separators), null]) {
    const to = match ? match.index : command.length;
    const words = command.slice(from, to).trim().split(/\s+/).filter(Boolean);
    while (
      words.length &&
      (/^\w+=/.test(words[0]!) || ['sudo', 'env', 'time', 'exec'].includes(words[0]!))
    )
      words.shift();
    const word = words[0];
    if (word && word !== 'cd') {
      const at = command.indexOf(word, from);
      return {
        program: fileName(word.replace(/^["']|["']$/g, '')),
        rest: command.slice(at + word.length).trim(),
      };
    }
    if (match) from = match.index + match[0].length;
  }
  return undefined;
}

/**
 * One line of thinking for a glance: the heading a model opens a thought with, else its first
 * sentence, with Markdown marks removed.
 */
export function getThoughtLine(text: string) {
  const heading = /^\s*\*\*([^*\r\n]+)\*\*[ \t]*\r?(?:\n|$)/.exec(text)?.[1];
  const line = (heading ?? text)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gm, '')
    .replace(/`+|\*\*|~~/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (heading !== undefined) return line;
  const end = /[.?!]["'”’)]?(?=\s)/.exec(line);
  return end ? line.slice(0, end.index + end[0].length) : line;
}

const verbs = {
  read: ['Reading', 'Read'],
  edit: ['Editing', 'Edited'],
  write: ['Writing', 'Wrote'],
  command: ['Running', 'Ran'],
  tool: ['Using', 'Used'],
} as const;

/** A step's headline, in the present while it runs or waits and the past once it has ended. */
export function describeActivityHeadline(
  step: ActivityStep,
  transcript: Pick<ChatTranscript, 'source'>,
  evidence: ActivityEvidence,
): ActivityHeadline {
  const state = getActivityStepState(step, transcript, evidence);
  const problem = describeActivityState(state);
  const ongoing = state === 'running' || state === 'requested';
  const lead = step.lead;
  if (lead.kind === 'thinking') {
    const line = lead.availability === 'available' ? getThoughtLine(lead.text) : '';
    return {
      category: 'thinking',
      action: line || (ongoing ? 'Thinking' : 'Thought'),
      detail: lead.availability === 'available' ? '' : lead.availability,
      ...(problem ? { problem } : {}),
    };
  }
  const name = lead.toolName ?? 'tool';
  const tense = ongoing ? 0 : 1;
  // A call's output, patch and details are often recorded in a later row.
  const recorded =
    lead.kind === 'arguments' && transcript.source.kind === 'entry'
      ? (evidence.get(callKey(transcript, transcript.source.entryId, lead.partId)) ?? [])
      : [];
  const parts = [lead, ...step.answers, ...recorded];
  if (['read', 'write', 'edit'].includes(name)) {
    const path = parts.map((part) => getToolArgument(part, ['path', 'file_path'])).find(Boolean);
    const changes = parts
      .filter((part) => part.kind === 'patch' || part.kind === 'diff')
      .map(countPatchLines)
      .find(Boolean);
    const kind = name as 'read' | 'write' | 'edit';
    return {
      category: kind === 'read' ? 'read' : 'edit',
      action: `${verbs[kind][tense]} ${path ? fileName(path) : 'a file'}`,
      // The verb phrase names the file; the detail adds its folder.
      detail: [changes, path?.split(/[\\/]/).slice(0, -1).join('/')].filter(Boolean).join(' · '),
      ...(problem ? { problem } : {}),
      ...(path && kind !== 'read' ? { path } : {}),
    };
  }
  if (name === 'bash' || name === 'powershell') {
    const command = parts.map((part) => getToolArgument(part, ['command'])).find(Boolean);
    const split = command ? splitCommand(command) : undefined;
    const output = parts.find((part) => part.kind === 'result');
    return {
      category: 'command',
      action: `${verbs.command[tense]} ${split?.program ?? 'a command'}`,
      // The verb phrase names the program; the detail is the rest of its line.
      detail: split ? split.rest : (command ?? (output ? excerpt(output) : '')),
      ...(problem ? { problem } : {}),
    };
  }
  return {
    category: 'tool',
    action: `${verbs.tool[tense]} ${name}`,
    detail: getToolSummary(lead).slice(name.length + 3),
    ...(problem ? { problem } : {}),
  };
}

const counters = {
  read: ['Read', 'file', 'files'],
  edit: ['Edited', 'file', 'files'],
  command: ['Ran', 'command', 'commands'],
  tool: ['Used', 'tool', 'tools'],
} as const;

/** A finished run of steps in one line: "Read 2 files, ran 3 commands". Thinking is not counted. */
export function summarizeActivityHeadlines(headlines: readonly ActivityHeadline[]) {
  const counts = new Map<keyof typeof counters, number>();
  const edited = new Set<string>();
  for (const headline of headlines) {
    if (headline.category === 'thinking') continue;
    if (headline.category === 'edit' && headline.path) {
      if (edited.has(headline.path)) continue;
      edited.add(headline.path);
    }
    counts.set(headline.category, (counts.get(headline.category) ?? 0) + 1);
  }
  const phrases = [...counts].map(([category, count], index) => {
    const [verb, one, many] = counters[category];
    const phrase = `${verb} ${count} ${count === 1 ? one : many}`;
    return index ? phrase[0]!.toLowerCase() + phrase.slice(1) : phrase;
  });
  return phrases.join(', ') || 'Thought';
}
