import { getParentPath } from '@moonbase/contracts/paths';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { readOwn } from '@moonbase/application/editor';
import { listFoldersToExpand } from './files-tree-drop.ts';
import type { EditorActions } from '../editor-actions.ts';

/**
 * Expands the folders that show `paths` in a checkout's tree, lists the newly expanded ones, and
 * selects `paths`, focusing the first.
 */
export function selectEntries(
  actions: EditorActions,
  checkout: CheckoutTarget,
  paths: readonly string[],
) {
  const tree = readOwn(actions.getSnapshot().recovery.views, checkout.checkoutId)?.tree;
  if (!tree || !paths.length) return;
  const opening = [
    ...new Set(paths.flatMap((path) => listFoldersToExpand(getParentPath(path)))),
  ].filter((folder) => !tree.expanded.includes(folder));
  actions.tree(checkout, {
    expanded: [...tree.expanded, ...opening],
    focus: paths[0],
    selected: [...paths],
  });
  for (const folder of opening) void actions.list(checkout, folder).catch(actions.report);
}
