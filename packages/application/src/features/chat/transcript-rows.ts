import type { ChatEntry, ChatRun, ChatToolActivity } from '@moonbase/contracts/chat';
import { areJsonValuesEqual } from '@moonbase/contracts/common';

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

/**
 * Lists `entries` (oldest first), then the run's live row and its legacy tool previews. Rows that
 * equal one in `previous` are that row, so an unchanged list is `previous` itself.
 */
export function listTranscriptRows(
  entries: readonly ChatEntry[],
  run: ChatRun | null | undefined,
  previous: readonly TranscriptRow[],
): TranscriptRow[] {
  const rows = entries.map(makeEntryRow);
  if (run) {
    const key = `live:${run.stop.submissionId}`;
    rows.push({
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
    });
    if (!run.transcript)
      for (const tool of run.tools) rows.push({ kind: 'tool', key: `tool:${tool.taskId}`, tool });
  }
  const before = new Map(
    previous.filter((row) => row.kind !== 'entry').map((row) => [row.key, row]),
  );
  for (let index = entries.length; index < rows.length; index++) {
    const old = before.get(rows[index].key);
    if (old && areJsonValuesEqual(old, rows[index])) rows[index] = old;
  }
  return rows.length === previous.length && rows.every((row, index) => row === previous[index])
    ? (previous as TranscriptRow[])
    : rows;
}
