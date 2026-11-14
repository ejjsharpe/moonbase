import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import type { OperationFeed, OperationFeedEntry } from '@moonbase/contracts/workspace-host';
import {
  maximumOperationFeedBytes,
  maximumOperationFeedPage,
} from '@moonbase/contracts/workspace-host-schema';
import type { Store } from '../store.ts';

/** The counter holding a checkout's floor: entries up to it may have been discarded. */
export const floorKey = (checkoutId: string) => 'feed-floor/' + checkoutId;

/**
 * One page of the operation feed for a checkout: its entries after `after`, in sequence order.
 * `epoch` names the store the sequences belong to.
 */
export function readOperationFeed(
  store: Store,
  epoch: string,
  target: CheckoutTarget,
  after: number | null,
): OperationFeed {
  const latest = store.get<number>('counters', 'feed') ?? 0;
  const floor = store.get<number>('counters', floorKey(target.checkoutId)) ?? 0;
  if (after === null) return { operations: [], through: latest, floor, epoch, more: false };
  const rows = store
    .statement('SELECT body FROM feed WHERE checkout=? AND sequence>? ORDER BY sequence LIMIT ?')
    .all(target.checkoutId, after, maximumOperationFeedPage + 1)
    .map((row) => store.parse<OperationFeedEntry>('feed', row.body));
  // A page also stays within `maximumOperationFeedBytes` (at least one entry), so any page
  // fits a reply however many items its entries carry.
  let bytes = 0,
    kept = 0;
  for (const row of rows.slice(0, maximumOperationFeedPage)) {
    bytes += Buffer.byteLength(JSON.stringify(row));
    if (kept && bytes > maximumOperationFeedBytes) break;
    kept++;
  }
  const more = rows.length > kept;
  const page = rows.slice(0, kept);
  return {
    operations: page,
    through: more ? page[page.length - 1].sequence : Math.max(latest, after),
    floor,
    epoch,
    more,
  };
}
