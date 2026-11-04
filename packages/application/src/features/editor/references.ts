import type {
  CheckoutTarget,
  CheckoutView,
  EditorRecovery,
  FileTarget,
  FileView,
} from '@moonbase/contracts/workspace';
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

export type ClosedAction = {
  checkout: CheckoutTarget;
  files: {
    path: string;
    index: number;
    view: FileView;
    positions?: CheckoutView['positions'][string];
  }[];
  active: string;
};

/** Apply exact captured close references; buffers and draft decisions stay with the caller. */
export function closeRecoveryReferences(
  state: EditorRecovery,
  targets: readonly FileTarget[],
  kind: 'files' | 'checkout' | 'quit',
  checkout?: CheckoutTarget,
  remember = false,
): ClosedAction[] {
  const keys = new Set(targets.map(fileKey));
  const history: ClosedAction[] = [];
  if (kind === 'files')
    for (const target of state.checkouts) {
      const selected = readOwn(state.views, target.checkoutId);
      if (!selected) continue;
      const closing = selected.openFiles.filter((path) =>
        keys.has(fileKey({ checkout: target, path })),
      );
      if (!closing.length) continue;
      if (remember)
        history.push({
          checkout: target,
          active: closing.includes(selected.active) ? selected.active : closing.at(-1)!,
          files: closing.map((path) => ({
            path,
            index: selected.openFiles.indexOf(path),
            view: readOwn(selected.fileViews, path) ?? 'file',
            positions: structuredClone(readOwn(selected.positions, path)),
          })),
        });
      selected.openFiles = selected.openFiles.filter((path) => !closing.includes(path));
      if (closing.includes(selected.active))
        selected.active =
          state.recentFiles.find(
            (item) =>
              checkoutKey(item.checkout) === checkoutKey(target) &&
              selected.openFiles.includes(item.path),
          )?.path ??
          selected.openFiles[0] ??
          '';
      if (selected.preview && closing.includes(selected.preview)) selected.preview = null;
    }
  if (kind === 'checkout' && checkout) {
    state.openCheckoutIds = state.openCheckoutIds.filter((id) => id !== checkout.checkoutId);
    if (state.selectedCheckoutId === checkout.checkoutId)
      state.selectedCheckoutId = state.openCheckoutIds.at(-1) ?? null;
  }

  return history;
}
