import { randomUUID } from 'node:crypto';
import { isPathAtOrInside } from '@moonbase/contracts/paths';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import type { RecoveryBuffer, RecoveryState } from '@moonbase/contracts/recovery';
import { isCheckoutPath } from '@moonbase/contracts/workspace-schema';
import { same } from '../validation.ts';
import type { OperationRecord } from './client-schema.ts';

/**
 * Applies completed moves, copies and Trash to one recovery. A move re-paths the buffers it
 * moves, so their tabs, views and drafts follow; Trash leaves every buffer where it was; a copy
 * gives each draft it copies a buffer of its own. A clean buffer open at a destination gives way
 * to what arrives there; one with a draft holds it, so neither draft is lost and the arriving one
 * stays where it was. The drafts left behind are returned, per checkout.
 */
export function reconcile(
  state: RecoveryState,
  records: OperationRecord[],
  mintId: () => string = randomUUID,
) {
  const collisions = new Map<string, { checkout: CheckoutTarget; paths: string[] }>();
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
      const occupant = (path: string, except?: RecoveryBuffer) =>
        state.buffers.find((b) => b !== except && inCheckout(b.target) && b.target.path === path);
      if (kind === 'copy') {
        // oxlint-disable-next-line no-useless-spread -- Copies append to state.buffers; visit only the originals.
        for (const buffer of [...state.buffers]) {
          if (!buffer.draft || !matches(buffer.target)) continue;
          const path = move(buffer.target.path),
            held = occupant(path);
          if (held?.draft) continue;
          const draft = structuredClone(buffer.draft);
          if (held) held.draft = draft;
          else state.buffers.push({ id: mintId(), target: { ...buffer.target, path }, draft });
        }
        continue;
      }
      // oxlint-disable-next-line no-useless-spread -- A buffer that gives way leaves state.buffers.
      for (const buffer of [...state.buffers]) {
        if (!state.buffers.includes(buffer) || !matches(buffer.target)) continue;
        const moved = move(buffer.target.path),
          held = occupant(moved, buffer);
        if (held?.draft) {
          if (buffer.draft) {
            const stranded = collisions.get(checkout.checkoutId) ?? { checkout, paths: [] };
            stranded.paths.push(buffer.target.path);
            collisions.set(checkout.checkoutId, stranded);
          }
          continue;
        }
        if (held) giveWay(state, held, buffer);
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

/** Removes a clean buffer for the one arriving at its file, which takes over its tab and view. */
function giveWay(state: RecoveryState, leaving: RecoveryBuffer, arriving: RecoveryBuffer) {
  state.buffers.splice(state.buffers.indexOf(leaving), 1);
  const view = state.views[leaving.target.checkout.checkoutId];
  if (!view) return;
  const swap = (id: string) => (id === leaving.id ? arriving.id : id);
  view.tabs = [...new Set(view.tabs.map(swap))];
  if (view.active !== null) view.active = swap(view.active);
  if (view.preview !== null) view.preview = swap(view.preview);
  for (const memory of [view.fileViews, view.positions] as Record<string, unknown>[]) {
    if (leaving.id in memory && !(arriving.id in memory)) memory[arriving.id] = memory[leaving.id];
    delete memory[leaving.id];
  }
}
