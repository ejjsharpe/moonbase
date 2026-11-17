import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { EntryRecord, Harness } from '@earendil-works/pi-durable';
import type { ChatHistoryPage, ChatTarget } from '@moonbase/contracts/chat';
import { getScanCursorScope, openScanCursor, writeScanCursor } from '../cursors.ts';
import { cid, eid } from '../documents.ts';
import { historyPageBytes, rowsPerPage } from '../page-limits.ts';
import { previewText } from '../text.ts';
import { projectEntryTranscript } from '../transcript/manifest.ts';

export async function readHistory(
  harness: Harness,
  {
    identity,
    target,
    cursor,
    upperEntryId,
    continuations,
    signal,
  }: {
    identity: string;
    target: ChatTarget;
    cursor?: string;
    /** Newest entry to include; `null` reads an empty conversation. */
    upperEntryId?: string | null;
    /** Receives the older cursor after each returned entry. */
    continuations?: (string | null)[];
    signal?: AbortSignal;
  },
): Promise<ChatHistoryPage> {
  if (upperEntryId === null) return { entries: [], olderCursor: null };
  const scope = getScanCursorScope(identity, target.conversationId);
  let scan = openScanCursor(cursor, 'history', scope);
  const entries: ChatHistoryPage['entries'] = [];
  let scanned = 0;
  do {
    signal?.throwIfAborted();
    const page = await harness.commit(
      (tx) =>
        tx.scanEntries(
          {
            conversationId: cid(target.conversationId),
            order: 'descending',
            ...(upperEntryId ? { maxEntryId: eid(upperEntryId) } : {}),
          },
          1,
          scan,
        ),
      context,
    );
    const row = page.items[0];
    if (!row) {
      scan = undefined;
      break;
    }
    const entry = await projectEntry(harness, target, row, signal);
    const candidate = {
      entries: [...entries, entry],
      olderCursor: writeScanCursor(page.next, 'history', scope),
    };
    if (Buffer.byteLength(JSON.stringify(candidate)) > historyPageBytes) {
      return {
        entries,
        olderCursor: writeScanCursor(scan ?? { start: true }, 'history', scope),
      };
    }
    entries.push(entry);
    continuations?.push(candidate.olderCursor);
    scan = page.next;
  } while (scan && ++scanned < rowsPerPage);
  return {
    entries,
    olderCursor: writeScanCursor(scan ?? undefined, 'history', scope),
  };
}
export async function projectEntry(
  harness: Harness,
  target: ChatTarget,
  entry: EntryRecord,
  signal?: AbortSignal,
): Promise<ChatHistoryPage['entries'][number]> {
  const message = entry.model?.[0];
  const transcript = await projectEntryTranscript(harness, target, entry, signal);
  if (!message)
    return {
      id: String(entry.id),
      role: 'system',
      ...previewText(transcript.parts[0]?.text ?? 'Transcript record.'),
      transcript,
    };
  const role = message.role === 'toolResult' ? 'tool' : message.role;
  if (role !== 'user' && role !== 'assistant' && role !== 'tool' && role !== 'system')
    return {
      id: String(entry.id),
      role: 'system',
      text: 'Unsupported transcript record.',
      truncated: false,
      transcript,
    };
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content
          .filter((x) => x.type === 'text')
          .map((x) => x.text)
          .join('');
  const failed = message.role === 'assistant' && message.stopReason === 'error';
  // An empty interrupted or failed message shows the transcript's label instead of blank text.
  const empty = transcript.parts.find((part) => part.partId === 'm0.empty')?.text;
  const recorded = new Date(message.timestamp);
  return {
    id: String(entry.id),
    transcript,
    role,
    ...(Number.isFinite(recorded.getTime()) ? { createdAt: recorded.toISOString() } : {}),
    ...previewText(failed ? 'Model response failed.' : text || empty || ''),
    ...(message.role === 'toolResult'
      ? { toolName: previewText(message.toolName, 128).text, isError: message.isError }
      : {}),
  };
}
