import { randomUUID } from 'node:crypto';
import { isPathAtOrInside } from '@moonbase/contracts/paths';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import type { RecoveryState } from '@moonbase/contracts/recovery';
import { isCheckoutPath } from '@moonbase/contracts/workspace-schema';
import { same } from '../validation.ts';
import type { OperationRecord } from './client-schema.ts';

/**
 * Applies completed moves, copies and Trash to one recovery. A move re-paths the buffers it
 * moves, so their tabs, views and drafts follow; Trash leaves every buffer where it was; a copy
 * gives each draft it copies a buffer of its own. A buffer whose destination another buffer
 * already holds stays where it was; the checkouts where that left a draft behind are returned.
 */
export function reconcile(
  state: RecoveryState,
  records: OperationRecord[],
  mintId: () => string = randomUUID,
) {
  const collisions = new Map<string, CheckoutTarget>();
  for (const record of records) {
    const checkout = record.input.checkout;
    if (!state.checkouts.some((c) => same(c, checkout))) continue;
    for (const item of record.result.items) {
      if (item.outcome !== 'completed') continue;
      const kind = record.input.kind;
      if (!['move', 'copy', 'trash'].includes(kind)) continue;
      // Trash never proves permission to discard another client's dirty work.
      if (kind === 'trash' || !item.destination) continue;
      // An item that names no exact checkout path (a host's reply is untrusted) moves nothing.
      if (!isCheckoutPath(item.source) || !isCheckoutPath(item.destination)) continue;
      const destination = item.destination;
      const inCheckout = (target: { checkout: CheckoutTarget }) => same(target.checkout, checkout);
      const matches = (target: { checkout: CheckoutTarget; path: string }) =>
        inCheckout(target) && isPathAtOrInside(target.path, item.source);
      const move = (p: string) => destination + p.slice(item.source.length);
      const occupied = (path: string) =>
        state.buffers.some((b) => inCheckout(b.target) && b.target.path === path);
      if (kind === 'copy') {
        // oxlint-disable-next-line no-useless-spread -- Copies append to state.buffers; visit only the originals.
        for (const buffer of [...state.buffers])
          if (buffer.draft && matches(buffer.target) && !occupied(move(buffer.target.path)))
            state.buffers.push({
              id: mintId(),
              target: { ...buffer.target, path: move(buffer.target.path) },
              draft: structuredClone(buffer.draft),
            });
        continue;
      }
      for (const buffer of state.buffers) {
        if (!matches(buffer.target)) continue;
        const moved = move(buffer.target.path);
        // Another buffer already holds the destination: neither is dropped, and a draft left
        // behind marks the checkout's history so it is reported.
        if (occupied(moved)) {
          if (buffer.draft) collisions.set(checkout.checkoutId, checkout);
          continue;
        }
        buffer.target = { ...buffer.target, path: moved };
      }
      state.recentFiles = state.recentFiles.map((t) =>
        matches(t) ? { ...t, path: move(t.path) } : t,
      );
      const view = state.views[checkout.checkoutId];
      if (view) {
        const rename = (p: string) => (isPathAtOrInside(p, item.source) ? move(p) : p);
        view.remembered = Object.fromEntries(
          Object.entries(view.remembered).map(([p, file]) => [rename(p), file]),
        );
        view.tree.expanded = view.tree.expanded.map(rename);
        view.tree.selected = view.tree.selected.map(rename);
        view.tree.focus = rename(view.tree.focus);
      }
    }
  }
  return collisions;
}
