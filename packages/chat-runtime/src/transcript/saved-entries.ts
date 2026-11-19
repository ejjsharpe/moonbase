import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { EntryId, Harness } from '@earendil-works/pi-durable';
import { Effect } from 'effect';
import type { ChatTarget } from '@moonbase/contracts/chat';
import { InvalidChatRequestError } from '@moonbase/contracts/chat-errors';
import { callHarness } from '../commands/harness-call.ts';
import { runCheck } from '../commands/safe-error.ts';
import { cid, eid } from '../documents.ts';

export const readEntry = (harness: Harness, target: ChatTarget, id: string) =>
  Effect.gen(function* () {
    const conversationId = yield* runCheck(() => cid(target.conversationId));
    const entry = yield* callHarness(() => harness.commit((tx) => tx.entry(eid(id)), context));
    if (!entry || entry.conversationId !== conversationId)
      return yield* new InvalidChatRequestError({ problem: 'entry' });
    return entry;
  });
/**
 * Reads the first entry at or past `position` in `direction`; newer scans stop at `upper`.
 * Without a position, an older scan returns the conversation's latest entry.
 */
export const scanAdjacentEntry = (
  harness: Harness,
  target: ChatTarget,
  direction: 'older' | 'newer',
  position?: number,
  upper?: string,
) =>
  Effect.map(
    callHarness(() => {
      let range: { minEntryId?: EntryId; maxEntryId?: EntryId } = {};
      if (direction === 'newer')
        range = {
          minEntryId: eid(String(position ?? 1)),
          ...(upper === undefined ? {} : { maxEntryId: eid(upper) }),
        };
      else if (position !== undefined) range = { maxEntryId: eid(String(position)) };
      return harness.commit(
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
    }),
    (page) => page.items[0],
  );
