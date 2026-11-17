import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { EntryId, Harness } from '@earendil-works/pi-durable';
import type { ChatTarget } from '@moonbase/contracts/chat';
import { InvalidChatRequestError } from '@moonbase/contracts/chat-errors';
import { cid, eid } from '../documents.ts';

export async function readEntry(harness: Harness, target: ChatTarget, id: string) {
  const entry = await harness.commit((tx) => tx.entry(eid(id)), context);
  if (!entry || entry.conversationId !== cid(target.conversationId))
    throw new InvalidChatRequestError({ problem: 'entry' });
  return entry;
}
/**
 * Reads the first entry at or past `position` in `direction`; newer scans stop at `upper`.
 * Without a position, an older scan returns the conversation's latest entry.
 */
export async function scanAdjacentEntry(
  harness: Harness,
  target: ChatTarget,
  direction: 'older' | 'newer',
  position?: number,
  upper?: string,
) {
  let range: { minEntryId?: EntryId; maxEntryId?: EntryId } = {};
  if (direction === 'newer')
    range = {
      minEntryId: eid(String(position ?? 1)),
      ...(upper === undefined ? {} : { maxEntryId: eid(upper) }),
    };
  else if (position !== undefined) range = { maxEntryId: eid(String(position)) };
  const page = await harness.commit(
    (tx) =>
      tx.scanEntries(
        {
          conversationId: cid(target.conversationId),
          order: direction === 'older' ? 'descending' : 'ascending',
          ...range,
        },
        1,
      ),
    context,
  );
  return page.items[0];
}
