import type { LiveEntry } from '@moonbase/application/chat';
import type { ChatEntry, ChatTranscript, ChatTranscriptPart } from '@moonbase/contracts/chat';
import { areJsonValuesEqual } from '@moonbase/contracts/common';
import { structuredSourceLimits } from './source-limits.ts';
import { parseRecordedPatch } from './recorded-patch-model.ts';

export function isActivityPart(part: ChatTranscriptPart) {
  return (
    part.kind === 'thinking' ||
    part.role === 'tool' ||
    ['arguments', 'executed-arguments', 'patch', 'diff', 'details', 'result'].includes(part.kind) ||
    (part.kind === 'notice' && !!part.toolName)
  );
}

/**
 * A thought with nothing to read: a provider can send one with only its signature or encrypted
 * reasoning. It shows no step of its own.
 */
export const isEmptyThought = (part: ChatTranscriptPart) =>
  part.kind === 'thinking' &&
  part.availability === 'available' &&
  !part.truncated &&
  !part.text.trim();

/**
 * The thoughts a reply's text follows. The text takes their place, as it does in the live response
 * once it arrives; a thought that leads into tool work stays a step.
 */
export function findAnsweredThoughts(parts: readonly ChatTranscriptPart[]) {
  const answered = new Set<string>();
  let thoughts: string[] = [];
  for (const part of parts) {
    if (part.kind === 'thinking') {
      thoughts.push(part.partId);
      continue;
    }
    if (part.kind === 'text' && part.role === 'assistant')
      for (const id of thoughts) answered.add(id);
    thoughts = [];
  }
  return answered;
}

/**
 * How an entry reads in the transcript. Pi records each tool call, result and turn marker as its
 * own entry: an empty marker takes no space, and calls and results read as activity, which
 * consecutive rows join into one card. A reply that only thought, with nothing to read, is empty
 * too.
 */
export function classifyEntry(entry: LiveEntry): 'empty' | 'activity' | 'message' {
  const parts = entry.transcript?.parts ?? [];
  if (
    entry.role === 'system' &&
    !entry.text.trim() &&
    parts.every((part) => part.kind === 'text' && part.bytes === 0)
  )
    return 'empty';
  if (
    entry.role === 'assistant' &&
    !entry.text.trim() &&
    parts.length &&
    parts.every(isEmptyThought)
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
 * The list keys an item's content and measured size by the item's key, so a new key remounts it.
 * Rows join a run at its start (history loading above) and its end (the live response, a later
 * page), so a run holding a row of a `previous` item keeps that item's key. The live row (any row
 * not `entry`) leaves a run as the answer starts, and the key stays with the part the reader is
 * in: the live row when they follow the live edge (`following`), so a selection, focus or Find
 * fold in the running response survives, else the card's stored rows, which the list holds in
 * place. Otherwise, when an item splits the first run keeps it, and a new item is keyed by its
 * last row. Keys are list keys only: `findReadingAnchor` names a row.
 */
export type TranscriptItem<Row> = { key: string; rows: readonly Row[] };
export function groupTranscriptRows<Row extends { key: string; kind: string }>(
  rows: readonly Row[],
  kindOf: (row: Row) => 'empty' | 'activity' | 'message',
  previous: readonly TranscriptItem<Row>[],
  following = false,
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
  const runOf = new Map(runs.flatMap((run) => run.map((row) => [row.key, run])));
  const claimed = new Set<string>();
  const carried = new Map<Row[], TranscriptItem<Row>>();
  const carry = (run: Row[], old: TranscriptItem<Row>) => {
    claimed.add(old.key);
    carried.set(run, old);
  };
  // Following, a live row that left its item's other rows keeps the item.
  if (following)
    for (const run of runs)
      for (const row of run) {
        const old = row.kind !== 'entry' ? itemOf.get(row.key) : undefined;
        if (old && !claimed.has(old.key) && old.rows.some((value) => runOf.get(value.key) !== run))
          carry(run, old);
      }
  for (const run of runs) {
    if (carried.has(run)) continue;
    const old = run
      .map((row) => itemOf.get(row.key))
      .find((item) => item && !claimed.has(item.key));
    if (old) carry(run, old);
  }
  return runs.map((run): TranscriptItem<Row> => {
    const old = carried.get(run);
    if (old?.rows.length === run.length && old.rows.every((row, i) => row === run[i])) return old;
    let key = old?.key ?? run.at(-1)!.key;
    // A row's key can name another run's carried key, so a new key must be unclaimed.
    for (let suffix = 1; !old && claimed.has(key); suffix++) key = `${run.at(-1)!.key}#${suffix}`;
    claimed.add(key);
    return { key, rows: run };
  });
}

/**
 * The reading anchor for the list's first visible item: a stored row and how far the viewport top
 * is below that row's own top, so it holds however much of a card a restore reads above the row.
 * `visible` is the item and its offset from the item's top; `rowTop` is a row's top within its
 * item, in the same terms (undefined while unmeasured or not shown). The anchor is the stored row the
 * viewport top is in or below, or a live row's nearest stored row above it, at its offset from
 * that row's item (`measure`), so a reader in the live response isn't taken to follow the live
 * edge. With no stored row above, it names the item's first row.
 */
export function findReadingAnchor<Row extends { key: string; kind: string }>(
  items: readonly TranscriptItem<Row>[],
  visible: { key: string; offset: number },
  {
    measure,
    rowTop,
  }: {
    measure(itemKey: string): number | undefined;
    rowTop(rowKey: string): number | undefined;
  },
) {
  const index = items.findIndex((item) => item.key === visible.key);
  if (index < 0) return undefined;
  for (let i = index; i >= 0; i--) {
    const item = items[i]!;
    const offset = i === index ? visible.offset : measure(item.key);
    if (offset === undefined) return undefined;
    let anchor: { key: string; offset: number } | undefined;
    for (const [position, row] of item.rows.entries()) {
      // The first row is at the item's top, unless something sits above it (a folded run's
      // line); a row the item doesn't show (a folded run's) has no top and ends the search.
      const top = rowTop(row.key) ?? (position ? undefined : 0);
      // A row landed a fraction of a device pixel below the viewport top still holds it.
      if (top === undefined || (top > offset + 1 && anchor)) break;
      if (row.kind === 'entry') anchor = { key: row.key, offset: offset - top };
    }
    if (anchor) return anchor;
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

/**
 * The words a state adds to its glyph. Completed (✓), running (spinner) and requested (○) need
 * none; a failure is worth saying in words.
 */
export function describeActivityState(state: string | undefined) {
  if (!state || ['completed', 'running', 'requested'].includes(state)) return undefined;
  return state === 'missing-result' ? 'no result' : state;
}

/** A tool call with the parts that answer it in the same group, shown as one step. */
export type ActivityStep = { lead: ChatTranscriptPart; answers: ChatTranscriptPart[] };

/** The call in another row a step answers, when the step is that call's output. */
export const getAnsweredCall = (step: ActivityStep) =>
  step.lead.call && step.lead.pairing === 'matched' && step.lead.kind !== 'arguments'
    ? step.lead.call
    : undefined;

/**
 * Pairs each part with the call it answers: the call itself when it is in this group (from the
 * row's own entry), else the first answer to the same call here, so an edit's output, details,
 * patch and diff read as one step. Consecutive thinking blocks are one thought, so one step; an
 * empty thought is no step.
 */
export function groupActivitySteps(parts: readonly ChatTranscriptPart[], entryId?: string) {
  const steps: ActivityStep[] = [],
    calls = new Map<string, ActivityStep>(),
    answered = new Map<string, ActivityStep>();
  let previousPart: ChatTranscriptPart | undefined;
  for (const part of parts) {
    if (isEmptyThought(part)) continue;
    const previous = steps.at(-1),
      follows = previousPart?.kind === 'thinking';
    previousPart = part;
    if (part.kind === 'thinking' && !part.call && follows && previous?.lead.kind === 'thinking') {
      previous.answers.push(part);
      continue;
    }
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

/** A call's tool and its main argument: "bash · npm test", "read · src/a.ts". */
export function getToolSummary(part: ChatTranscriptPart, text = part.text) {
  const name = part.toolName ?? 'Tool';
  const value = getToolArgument(part, text);
  return value === undefined ? name : `${name} · ${value.replace(/\s+/g, ' ').slice(0, 160)}`;
}

export function getEntryTranscripts(
  entries: ChatEntry[],
  manifest: Pick<ChatTranscript, 'source' | 'parts'> | null,
) {
  return entries.map((entry) =>
    manifest?.parts.length && areJsonValuesEqual(manifest.source, entry.transcript.source)
      ? manifest
      : entry.transcript,
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

/** The arguments that name what a tool acts on: a path for file tools, a shell's command. */
const getArgumentKeys = (tool: string | undefined) => {
  if (tool === 'read' || tool === 'write' || tool === 'edit') return ['path', 'file_path'];
  if (tool === 'bash' || tool === 'powershell') return ['command'];
  return [];
};

/** A call's main argument (a command or a path) from its recorded JSON. */
function getToolArgument(part: ChatTranscriptPart, text = part.text): string | undefined {
  const keys = getArgumentKeys(part.toolName);
  if (
    !keys.length ||
    !['arguments', 'executed-arguments'].includes(part.kind) ||
    text.length > structuredSourceLimits.units
  )
    return undefined;
  try {
    const args: unknown = JSON.parse(text);
    if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
    const value = keys.map((key) => (args as Record<string, unknown>)[key]).find(Boolean);
    return typeof value === 'string' ? value : undefined;
  } catch {
    // A preview cut short of its JSON still names a leading path or command.
    for (const key of keys) {
      const found = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
      if (!found) continue;
      try {
        return JSON.parse(`"${found[1]}"`) as string;
      } catch {
        return found[1];
      }
    }
    return undefined;
  }
}

/** Commands that run another, and their options that take a value. */
const commandWrappers: Record<string, readonly string[]> = {
  sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U'],
  env: ['-u', '-C', '-S'],
  time: ['-f', '-o'],
  nice: ['-n'],
  nohup: [],
  exec: ['-a'],
  command: [],
  builtin: [],
};

/**
 * The program a shell line runs, past `cd` hops, variable assignments and wrappers (with their
 * options), and the rest of the line after it.
 */
export function splitCommand(command: string) {
  for (const segment of command.matchAll(/[^;&|]+/g)) {
    const words = [...segment[0].matchAll(/\S+/g)];
    let index = 0;
    while (index < words.length) {
      const word = words[index]![0];
      const options = commandWrappers[word];
      if (/^\w+=/.test(word)) index++;
      else if (options) {
        index++;
        while (index < words.length && words[index]![0].startsWith('-'))
          index += options.includes(words[index]![0]) ? 2 : 1;
      } else break;
    }
    const found = words[index];
    if (!found || found[0] === 'cd') continue;
    const end = segment.index + found.index + found[0].length;
    return {
      program: fileName(found[0].replace(/^["']|["']$/g, '')),
      rest: command.slice(end).trim(),
    };
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
  // A saved call with no result among the rows read: it isn't still running, its result just
  // isn't shown. Only a live call waits for its result.
  const live = transcript.source.kind === 'live';
  const unanswered = state === 'requested' && !live;
  const problem = unanswered ? 'no result shown' : describeActivityState(state);
  const ongoing = state === 'running' || (state === 'requested' && live);
  const headline = describeHeadline(step, ongoing ? 0 : 1, transcript, evidence);
  return problem ? { ...headline, problem } : headline;
}

function describeHeadline(
  step: ActivityStep,
  tense: 0 | 1,
  transcript: Pick<ChatTranscript, 'source'>,
  evidence: ActivityEvidence,
): ActivityHeadline {
  const lead = step.lead;
  if (lead.kind === 'thinking') {
    const line = lead.availability === 'available' ? getThoughtLine(lead.text) : '';
    return {
      category: 'thinking',
      action: line || (tense ? 'Thought' : 'Thinking'),
      detail: lead.availability === 'available' ? '' : lead.availability,
    };
  }
  const name = lead.toolName ?? 'tool';
  // A call's output, patch and details are often recorded in a later row.
  const recorded =
    lead.kind === 'arguments' && transcript.source.kind === 'entry'
      ? (evidence.get(callKey(transcript, transcript.source.entryId, lead.partId)) ?? [])
      : [];
  const parts = [lead, ...step.answers, ...recorded];
  const argument = parts.map((part) => getToolArgument(part)).find(Boolean);
  if (name === 'read' || name === 'write' || name === 'edit') {
    const changes = parts
      .filter((part) => part.kind === 'patch' || part.kind === 'diff')
      .map(countPatchLines)
      .find(Boolean);
    return {
      category: name === 'read' ? 'read' : 'edit',
      action: `${verbs[name][tense]} ${argument ? fileName(argument) : 'a file'}`,
      // The verb phrase names the file; the detail adds its folder.
      detail: [changes, argument?.split(/[\\/]/).slice(0, -1).join('/')]
        .filter(Boolean)
        .join(' · '),
      ...(argument && name !== 'read' ? { path: argument } : {}),
    };
  }
  if (name === 'bash' || name === 'powershell') {
    const split = argument ? splitCommand(argument) : undefined;
    const output = parts.find((part) => part.kind === 'result');
    return {
      category: 'command',
      action: `${verbs.command[tense]} ${split?.program ?? 'a command'}`,
      // The verb phrase names the program; the detail is the rest of its line.
      detail: split ? split.rest : (argument ?? (output ? excerpt(output) : '')),
    };
  }
  return { category: 'tool', action: `${verbs.tool[tense]} ${name}`, detail: '' };
}

const counters = {
  read: [verbs.read[1], 'file', 'files'],
  edit: [verbs.edit[1], 'file', 'files'],
  command: [verbs.command[1], 'command', 'commands'],
  tool: [verbs.tool[1], 'tool', 'tools'],
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
