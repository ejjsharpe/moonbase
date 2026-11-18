import { isPathAtOrInside } from '@moonbase/contracts/paths';
import type {
  CheckoutTarget,
  FilePositions,
  FileTarget,
  FileView,
} from '@moonbase/contracts/workspace';
import type { EditorRecovery } from '../recovery/recovery-layout.ts';
import { checkoutKey, fileKey, sameCheckout } from '../keys.ts';

/** The editor's tabs and views: its recovery layout, and the closes Reopen can undo. */
export type ViewsState = { recovery: EditorRecovery; closed: readonly ClosedAction[] };

/** Whether the checkout is one the editor knows, under this exact target. */
export const isCheckoutListed = (recovery: EditorRecovery, checkout: CheckoutTarget) =>
  recovery.checkouts.some((item) => sameCheckout(item, checkout));
/** Whether the checkout is open in the editor, under this exact target. */
export const isCheckoutOpen = (recovery: EditorRecovery, checkout: CheckoutTarget) =>
  recovery.openCheckoutIds.includes(checkout.checkoutId) && isCheckoutListed(recovery, checkout);

/** The closes Reopen remembers, newest last: at most 20. */
export const rememberClosed = (closed: readonly ClosedAction[], actions: ClosedAction[]) =>
  [...closed, ...actions].slice(-20);

/** The newest close in `checkout`, with its index, for Reopen. */
export function findClosedAction(closed: readonly ClosedAction[], checkout: CheckoutTarget) {
  const index = closed.findLastIndex((action) => sameCheckout(action.checkout, checkout));
  return index < 0 ? undefined : { index, action: structuredClone(closed[index]) };
}

/** Closes Reopen can no longer undo, for files moved to the Trash. */
export const forgetTrashed = (
  closed: readonly ClosedAction[],
  checkout: CheckoutTarget,
  source: string,
) =>
  closed.flatMap((action) => {
    if (!sameCheckout(action.checkout, checkout)) return [action];
    const files = action.files.filter(
      (file) => file.path !== source && !file.path.startsWith(source + '/'),
    );
    return files.length ? [{ ...action, files }] : [];
  });

/** Closes in a checkout that became another target (after `git init`) follow it. */
export const rebindClosed = (
  closed: readonly ClosedAction[],
  previous: CheckoutTarget,
  next: CheckoutTarget,
) =>
  closed.map((action) =>
    sameCheckout(action.checkout, previous) ? { ...action, checkout: next } : action,
  );

/** Closes of moved files follow the move. */
export function moveClosed(
  closed: readonly ClosedAction[],
  checkout: CheckoutTarget,
  source: string,
  destination: string,
) {
  const move = (path: string) =>
    path === source || path.startsWith(source + '/')
      ? destination + path.slice(source.length)
      : path;
  return closed.map((action) =>
    sameCheckout(action.checkout, checkout)
      ? {
          ...action,
          active: move(action.active),
          files: action.files.map((file) => ({ ...file, path: move(file.path) })),
        }
      : action,
  );
}

/**
 * Moves what the editor remembers by path for a move: recent files, the files tree, and the view
 * and positions of files without a tab. Tabs follow their buffers in the recovery store.
 */
export function movePathsInRecovery(
  state: EditorRecovery,
  checkout: CheckoutTarget,
  source: string,
  destination: string,
) {
  const affected = (path: string) => isPathAtOrInside(path, source);
  const move = (path: string) => (affected(path) ? destination + path.slice(source.length) : path);
  const selected = state.views.get(checkout.checkoutId);
  if (selected) {
    const closed = (path: string) => affected(path) && !selected.openFiles.includes(path);
    const remap = <A>(memory: ReadonlyMap<string, A>) =>
      // Stationary destination metadata wins collisions, matching existing recovery behavior.
      new Map(
        [...memory]
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
    positions?: FilePositions;
  }[];
  active: string;
};

/** Closes the captured files in the recovery; buffers and draft decisions stay with the caller. */
export function closeFilesInRecovery(
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
      const selected = state.views.get(target.checkoutId);
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
            view: selected.fileViews.get(path) ?? 'file',
            positions: structuredClone(selected.positions.get(path)),
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
