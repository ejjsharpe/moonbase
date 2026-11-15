import { isPathAtOrInside } from '@moonbase/contracts/paths';
import type { CheckoutTarget, FileTarget, FileView } from '@moonbase/contracts/workspace';
import { readOwn } from './record.ts';
import type { CheckoutView, EditorRecovery } from './recovery-layout.ts';

export const checkoutKey = (target: CheckoutTarget) =>
  JSON.stringify([
    target.hostId,
    target.checkoutId,
    target.projectId,
    target.root,
    target.vcs,
    ...(target.vcs === 'git' ? [target.branch, target.worktree] : []),
  ]);
export const fileKey = (target: FileTarget) =>
  JSON.stringify([checkoutKey(target.checkout), target.path]);

/**
 * Moves what the editor remembers by path for a move: recent files, the files tree, and the view
 * and positions of files without a tab. Tabs follow their buffers in the recovery store.
 */
export function moveRecoveryReferences(
  state: EditorRecovery,
  checkout: CheckoutTarget,
  source: string,
  destination: string,
) {
  const affected = (path: string) => isPathAtOrInside(path, source);
  const move = (path: string) => (affected(path) ? destination + path.slice(source.length) : path);
  const selected = readOwn(state.views, checkout.checkoutId);
  if (selected) {
    const closed = (path: string) => affected(path) && !selected.openFiles.includes(path);
    const remap = <A>(memory: Record<string, A>) =>
      // Stationary destination metadata wins collisions, matching existing recovery behavior.
      Object.fromEntries(
        Object.entries(memory)
          .sort(([a], [b]) => Number(closed(b)) - Number(closed(a)))
          .map(([path, value]) => [closed(path) ? move(path) : path, value]),
      );
    selected.fileViews = remap(selected.fileViews);
    selected.positions = remap(selected.positions);
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
