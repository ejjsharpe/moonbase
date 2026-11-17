import type { Harness } from '@earendil-works/pi-durable';
import type { ChatHistoryPage, ChatInput, ChatOutput } from '@moonbase/contracts/chat';
import { InvalidChatRequestError } from '@moonbase/contracts/chat-errors';
import { openTranscriptCursor, writeCursor } from '../cursors.ts';
import { hashJson } from '../hash-json.ts';
import { entryListBytes, rowsPerPage } from '../page-limits.ts';
import { readEntry, scanAdjacentEntry } from '../transcript/saved-entries.ts';
import { projectEntry } from './history-page.ts';

export async function readHistoryAround(
  harness: Harness,
  input: ChatInput<'getChatHistoryAround'>,
  signal?: AbortSignal,
): Promise<ChatOutput<'getChatHistoryAround'>> {
  const { target } = input;
  await readEntry(harness, target, input.entryId);
  signal?.throwIfAborted();
  const binding = hashJson({ target, entryId: input.entryId });
  const cursor = input.cursor ? openTranscriptCursor(input.cursor, 'around', binding) : undefined;
  const upper = cursor?.upper ?? String((await scanAdjacentEntry(harness, target, 'older'))!.id);
  const entries: ChatHistoryPage['entries'] = [];
  async function scanNearby(direction: 'older' | 'newer', position: number) {
    signal?.throwIfAborted();
    if (position < 1 || position > Number(upper)) return undefined;
    return scanAdjacentEntry(harness, target, direction, position, upper);
  }
  async function collect(direction: 'older' | 'newer', start: number, limit: number) {
    let position = start;
    for (let i = 0; i < limit; i++) {
      const row = await scanNearby(direction, position);
      if (!row) break;
      signal?.throwIfAborted();
      const entry = await projectEntry(harness, target, row, signal);
      if (Buffer.byteLength(JSON.stringify([...entries, entry])) > entryListBytes) break;
      entries.push(entry);
      position = Number(row.id) + (direction === 'older' ? -1 : 1);
    }
  }
  if (cursor) {
    if (!cursor.direction || !cursor.upper)
      throw new InvalidChatRequestError({ problem: 'history-direction' });
    await collect(cursor.direction, cursor.position, rowsPerPage);
  } else {
    await collect('older', Number(input.entryId), rowsPerPage / 2);
    await collect('newer', Number(input.entryId) + 1, rowsPerPage / 2);
  }
  entries.sort((a, b) => Number(b.id) - Number(a.id));
  const first = Number(entries.at(-1)?.id ?? input.entryId),
    last = Number(entries[0]?.id ?? input.entryId);
  async function writeContinuation(direction: 'older' | 'newer', position: number) {
    return (await scanNearby(direction, position))
      ? writeCursor({ kind: 'around', binding, position, upper, direction })
      : null;
  }
  return {
    target,
    cursor: input.cursor ?? null,
    entryId: input.entryId,
    upperEntryId: upper,
    entries,
    olderCursor: await writeContinuation('older', first - 1),
    newerCursor: await writeContinuation('newer', last + 1),
  };
}
