import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { EntryRecord } from '@earendil-works/pi-durable';
import { Effect } from 'effect';
import type { ChatError } from '@moonbase/contracts/chat-errors';
import { callHarness } from '../commands/harness-call.ts';
import type { ChatHistoryPage, ChatTarget } from '@moonbase/contracts/chat';
import { getScanCursorScope, openScanCursor, writeScanCursor } from '../cursors.ts';
import { cid, eid } from '../documents.ts';
import { historyPageBytes, rowsPerPage } from '../page-limits.ts';
import { previewText } from '../text.ts';
import type { EntryReader } from '../transcript/entry-transcript.ts';
import { projectEntryTranscript } from '../transcript/manifest.ts';

/** What reading history needs: the store, the host's saved transcripts and its identity. */
export type HistoryReader = EntryReader & { identity: string };

export const readHistory = (
  reader: HistoryReader,
  {
    target,
    cursor,
    upperEntryId,
    continuations,
  }: {
    target: ChatTarget;
    cursor?: string;
    /** Newest entry to include; `null` reads an empty conversation. */
    upperEntryId?: string | null;
    /** Receives the older cursor after each returned entry. */
    continuations?: (string | null)[];
  },
): Effect.Effect<ChatHistoryPage, ChatError> =>
  Effect.gen(function* () {
    if (upperEntryId === null) return { entries: [], olderCursor: null };
    const { harness } = reader;
    const scope = getScanCursorScope(reader.identity, target.conversationId);
    let scan = yield* openScanCursor(cursor, 'history', scope);
    const entries: ChatHistoryPage['entries'] = [];
    let scanned = 0;
    do {
      const from = scan;
      const page = yield* callHarness(() =>
        harness.commit(
          (tx) =>
            tx.scanEntries(
              {
                conversationId: cid(target.conversationId),
                order: 'descending',
                ...(upperEntryId ? { maxEntryId: eid(upperEntryId) } : {}),
              },
              1,
              from,
            ),
          context,
        ),
      );
      const row = page.items[0];
      if (!row) {
        scan = undefined;
        break;
      }
      const entry = yield* projectEntry(reader, target, row);
      const candidate = {
        entries: [...entries, entry],
        olderCursor: yield* writeScanCursor(page.next, 'history', scope),
      };
      if (Buffer.byteLength(JSON.stringify(candidate)) > historyPageBytes) {
        return {
          entries,
          olderCursor: yield* writeScanCursor(scan ?? { start: true }, 'history', scope),
        };
      }
      entries.push(entry);
      continuations?.push(candidate.olderCursor);
      scan = page.next;
    } while (scan && ++scanned < rowsPerPage);
    return {
      entries,
      olderCursor: yield* writeScanCursor(scan ?? undefined, 'history', scope),
    };
  });
export const projectEntry = (
  reader: EntryReader,
  target: ChatTarget,
  entry: EntryRecord,
): Effect.Effect<ChatHistoryPage['entries'][number], ChatError> =>
  Effect.map(
    projectEntryTranscript(reader, target, entry),
    (transcript): ChatHistoryPage['entries'][number] => {
      const message = entry.model?.[0];
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
    },
  );
