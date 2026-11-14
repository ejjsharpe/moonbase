import { isPathAtOrInside } from '@moonbase/contracts/paths';
import type { CheckoutTarget, EditorRecovery } from '@moonbase/contracts/workspace';
import { isCheckoutPath } from '@moonbase/contracts/workspace-schema';
import { same } from '../validation.ts';
import type { OperationRecord } from './client-schema.ts';

/**
 * Applies completed moves, copies and Trash to one recovery. A move onto a path that already holds
 * a draft leaves the moving draft where it was; the checkouts where that happened are returned.
 */
export function reconcile(state: EditorRecovery, records: OperationRecord[]) {
  const collisions = new Map<string, CheckoutTarget>();
  for (const record of records) {
    if (!state.checkouts.some((c) => same(c, record.input.checkout))) continue;
    for (const item of record.result.items) {
      if (item.outcome !== 'completed') continue;
      const kind = record.input.kind;
      if (!['move', 'copy', 'trash'].includes(kind)) continue;
      if (kind !== 'trash' && !item.destination) continue;
      // An item that names no exact checkout path (a host's reply is untrusted) moves nothing.
      if (!isCheckoutPath(item.source) || (kind !== 'trash' && !isCheckoutPath(item.destination!)))
        continue;
      const matches = (target: { checkout: CheckoutTarget; path: string }) =>
        same(target.checkout, record.input.checkout) && isPathAtOrInside(target.path, item.source);
      const move = (p: string) => item.destination! + p.slice(item.source.length);
      const occupied = (path: string) =>
        state.drafts.some(
          (d) => same(d.target.checkout, record.input.checkout) && d.target.path === path,
        );
      if (kind === 'copy') {
        // oxlint-disable-next-line no-useless-spread -- Copies append to state.drafts; iterate only the original drafts.
        for (const draft of [...state.drafts])
          if (matches(draft.target) && !occupied(move(draft.target.path)))
            state.drafts.push({
              ...draft,
              target: { ...draft.target, path: move(draft.target.path) },
            });
        continue;
      }
      // Trash never proves permission to discard another client's dirty work.
      if (kind === 'move') {
        state.drafts = state.drafts.map((d) => {
          if (!matches(d.target)) return d;
          // Another draft already holds the destination: neither is dropped, and the checkout's
          // history is marked so the draft left behind is reported.
          if (occupied(move(d.target.path))) {
            collisions.set(record.input.checkout.checkoutId, record.input.checkout);
            return d;
          }
          return { ...d, target: { ...d.target, path: move(d.target.path) } };
        });
        state.recentFiles = state.recentFiles.map((t) =>
          matches(t) ? { ...t, path: move(t.path) } : t,
        );
        const view = state.views[record.input.checkout.checkoutId];
        if (view) {
          const rename = (p: string) => (isPathAtOrInside(p, item.source) ? move(p) : p);
          view.openFiles = [...new Set(view.openFiles.map(rename))];
          view.active = rename(view.active);
          if (view.preview) view.preview = rename(view.preview);
          view.fileViews = Object.fromEntries(
            Object.entries(view.fileViews).map(([p, mode]) => [rename(p), mode]),
          );
          view.positions = Object.fromEntries(
            Object.entries(view.positions).map(([p, positions]) => [rename(p), positions]),
          );
          view.tree.expanded = view.tree.expanded.map(rename);
          view.tree.selected = view.tree.selected.map(rename);
          view.tree.focus = rename(view.tree.focus);
        }
      }
    }
  }
  return collisions;
}
