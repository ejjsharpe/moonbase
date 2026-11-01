import type { CheckoutTarget, EditorRecovery, FileTarget } from '@moonbase/application/client';
import { readOwn } from './record.ts';

export const checkoutKey = (target: CheckoutTarget) =>
  JSON.stringify([target.hostId, target.checkoutId, target.projectId, target.root, target.branch]);
export const fileKey = (target: FileTarget) =>
  JSON.stringify([checkoutKey(target.checkout), target.path]);

/** Remap only view memory and recents; callers own buffers, drafts and validation. */
export function moveRecoveryReferences(
  state: EditorRecovery,
  checkout: CheckoutTarget,
  source: string,
  destination: string,
) {
  const affected = (path: string) => path === source || path.startsWith(source + '/');
  const move = (path: string) => (affected(path) ? destination + path.slice(source.length) : path);
  const selected = readOwn(state.views, checkout.checkoutId);
  if (selected) {
    selected.openFiles = [...new Set(selected.openFiles.map(move))];
    selected.active = move(selected.active);
    if (selected.preview) selected.preview = move(selected.preview);
    // Stationary destination metadata wins collisions, matching existing recovery behavior.
    const movedViews = Object.entries(selected.fileViews).sort(
      ([a], [b]) => Number(affected(b)) - Number(affected(a)),
    );
    const movedPositions = Object.entries(selected.positions).sort(
      ([a], [b]) => Number(affected(b)) - Number(affected(a)),
    );
    selected.fileViews = Object.fromEntries(movedViews.map(([path, mode]) => [move(path), mode]));
    selected.positions = Object.fromEntries(
      movedPositions.map(([path, positions]) => [move(path), positions]),
    );
    selected.tree.expanded = [...new Set(selected.tree.expanded.map(move))];
    selected.tree.selected = [...new Set(selected.tree.selected.map(move))];
    selected.tree.focus = move(selected.tree.focus);
  }
  const recentFiles = state.recentFiles.map((item) =>
    checkoutKey(item.checkout) === checkoutKey(checkout)
      ? { ...item, path: move(item.path) }
      : item,
  );
  state.recentFiles = [...new Map(recentFiles.map((item) => [fileKey(item), item])).values()];
}
