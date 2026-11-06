import type { ChatEntry, ChatRun, ChatToolActivity } from '@moonbase/contracts/chat';

/**
 * One row of the published transcript, keyed for a virtualized list. Stored entries are
 * `entry:<id>`, the running response is `live:<submissionId>` and a legacy host's tool previews
 * are `tool:<taskId>`. A row keeps its object identity while it is unchanged.
 */
export type TranscriptRow =
  | { kind: 'entry'; key: string; entry: ChatEntry }
  | { kind: 'live'; key: string; entry: ChatEntry; state: ChatRun['state'] }
  | { kind: 'tool'; key: string; tool: ChatToolActivity };

export const getEntryRowKey = (entryId: string) => `entry:${entryId}`;
/** The stored entry a row key names, or undefined for live and tool rows. */
export const findRowEntryId = (key: string) =>
  key.startsWith('entry:') ? key.slice('entry:'.length) : undefined;
/** Whether a row key names a live-edge row: the running response or a legacy tool preview. */
export const isLiveRowKey = (key: string) => key.startsWith('live:') || key.startsWith('tool:');

const entryRows = new WeakMap<ChatEntry, TranscriptRow>();
function makeEntryRow(entry: ChatEntry): TranscriptRow {
  let row = entryRows.get(entry);
  if (!row) entryRows.set(entry, (row = { kind: 'entry', key: getEntryRowKey(entry.id), entry }));
  return row;
}

/** A run's live row and legacy tool previews; a snapshot keeps an unchanged run's identity. */
const runRows = new WeakMap<ChatRun, TranscriptRow[]>();
function makeRunRows(run: ChatRun) {
  let rows = runRows.get(run);
  if (rows) return rows;
  const key = `live:${run.stop.submissionId}`;
  rows = [
    {
      kind: 'live',
      key,
      state: run.state,
      entry: {
        id: key,
        role: 'assistant',
        text: run.text,
        truncated: run.truncated,
        ...(run.transcript ? { transcript: run.transcript } : {}),
      },
    },
  ];
  if (!run.transcript)
    for (const tool of run.tools) rows.push({ kind: 'tool', key: `tool:${tool.taskId}`, tool });
  runRows.set(run, rows);
  return rows;
}

/**
 * Lists `entries` (oldest first), then the run's live row and its legacy tool previews. An
 * unchanged list is `previous` itself.
 */
export function listTranscriptRows(
  entries: readonly ChatEntry[],
  run: ChatRun | null | undefined,
  previous: readonly TranscriptRow[],
): TranscriptRow[] {
  const rows = entries.map(makeEntryRow);
  if (run) rows.push(...makeRunRows(run));
  return rows.length === previous.length && rows.every((row, index) => row === previous[index])
    ? (previous as TranscriptRow[])
    : rows;
}
