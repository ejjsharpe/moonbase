import { Effect } from 'effect';
import type { ChatHistoryPage, ChatInput, ChatOutput } from '@moonbase/contracts/chat';
import { InvalidChatRequestError, type ChatError } from '@moonbase/contracts/chat-errors';
import { openTranscriptCursor, writeCursor } from '../cursors.ts';
import { hashJson } from '../hash-json.ts';
import { entryListBytes, rowsPerPage } from '../page-limits.ts';
import type { EntryReader } from '../transcript/entry-transcript.ts';
import { readEntry, scanAdjacentEntry } from '../transcript/saved-entries.ts';
import { projectEntry } from './history-page.ts';

export const readHistoryAround = (
  reader: EntryReader,
  input: ChatInput<'getChatHistoryAround'>,
): Effect.Effect<ChatOutput<'getChatHistoryAround'>, ChatError> =>
  Effect.gen(function* () {
    const { harness } = reader;
    const { target } = input;
    yield* readEntry(harness, target, input.entryId);
    const binding = hashJson({ target, entryId: input.entryId });
    const cursor = input.cursor
      ? yield* openTranscriptCursor(input.cursor, 'around', binding)
      : undefined;
    const upper = cursor?.upper ?? String((yield* scanAdjacentEntry(harness, target, 'older'))!.id);
    const entries: ChatHistoryPage['entries'] = [];
    const scanNearby = (direction: 'older' | 'newer', position: number) =>
      position < 1 || position > Number(upper)
        ? Effect.succeed(undefined)
        : scanAdjacentEntry(harness, target, direction, position, upper);
    const collect = (direction: 'older' | 'newer', start: number, limit: number) =>
      Effect.gen(function* () {
        let position = start;
        for (let i = 0; i < limit; i++) {
          const row = yield* scanNearby(direction, position);
          if (!row) break;
          const entry = yield* projectEntry(reader, target, row);
          if (Buffer.byteLength(JSON.stringify([...entries, entry])) > entryListBytes) break;
          entries.push(entry);
          position = Number(row.id) + (direction === 'older' ? -1 : 1);
        }
      });
    if (cursor) {
      if (!cursor.direction || !cursor.upper)
        return yield* new InvalidChatRequestError({ problem: 'history-direction' });
      yield* collect(cursor.direction, cursor.position, rowsPerPage);
    } else {
      yield* collect('older', Number(input.entryId), rowsPerPage / 2);
      yield* collect('newer', Number(input.entryId) + 1, rowsPerPage / 2);
    }
    entries.sort((a, b) => Number(b.id) - Number(a.id));
    const first = Number(entries.at(-1)?.id ?? input.entryId),
      last = Number(entries[0]?.id ?? input.entryId);
    const writeContinuation = (direction: 'older' | 'newer', position: number) =>
      Effect.flatMap(scanNearby(direction, position), (row) =>
        row
          ? writeCursor({ kind: 'around', binding, position, upper, direction })
          : Effect.succeed(null),
      );
    return {
      target,
      cursor: input.cursor ?? null,
      entryId: input.entryId,
      upperEntryId: upper,
      entries,
      olderCursor: yield* writeContinuation('older', first - 1),
      newerCursor: yield* writeContinuation('newer', last + 1),
    };
  });
