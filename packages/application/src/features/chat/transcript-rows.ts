import type { ChatEntry, ChatRun, ChatTranscript } from '@moonbase/contracts/chat';

/** The running response as an entry; it has no transcript while the run's task is completing. */
export type LiveEntry = Omit<ChatEntry, 'transcript'> & { transcript?: ChatTranscript };
/**
 * One row of the published transcript, keyed for a virtualized list. Stored entries are
 * `entry:<id>` and the running response is `live:<submissionId>`. A row keeps its object identity
 * while it is unchanged.
 */
export type TranscriptRow =
  | { kind: 'entry'; key: string; entry: ChatEntry }
  | { kind: 'live'; key: string; entry: LiveEntry; state: ChatRun['state'] };

export const getEntryRowKey = (entryId: string) => `entry:${entryId}`;
/** The stored entry a row key names, or undefined for the live row. */
export const findRowEntryId = (key: string) =>
  key.startsWith('entry:') ? key.slice('entry:'.length) : undefined;
/** Whether a row key names the running response, at the live edge. */
export const isLiveRowKey = (key: string) => key.startsWith('live:');

const entryRows = new WeakMap<ChatEntry, TranscriptRow>();
function makeEntryRow(entry: ChatEntry): TranscriptRow {
  let row = entryRows.get(entry);
  if (!row) entryRows.set(entry, (row = { kind: 'entry', key: getEntryRowKey(entry.id), entry }));
  return row;
}

/** A run's live row; a snapshot keeps an unchanged run's identity. */
const runRows = new WeakMap<ChatRun, TranscriptRow>();
function makeRunRow(run: ChatRun) {
  let row = runRows.get(run);
  if (row) return row;
  const key = `live:${run.stop.submissionId}`;
  row = {
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
  };
  runRows.set(run, row);
  return row;
}

/** Lists `entries` (oldest first), then the run's live row. An unchanged list is `previous` itself. */
export function listTranscriptRows(
  entries: readonly ChatEntry[],
  run: ChatRun | null | undefined,
  previous: readonly TranscriptRow[],
): TranscriptRow[] {
  const rows = entries.map(makeEntryRow);
  if (run) rows.push(makeRunRow(run));
  return rows.length === previous.length && rows.every((row, index) => row === previous[index])
    ? (previous as TranscriptRow[])
    : rows;
}
