import { getParentPath } from '@moonbase/contracts/paths';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
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
  const tree = actions.read(actions.atoms.views.checkoutTree(checkout.checkoutId));
  if (!tree || !paths.length) return;
  const opening = [
    ...new Set(paths.flatMap((path) => listFoldersToExpand(getParentPath(path)))),
  ].filter((folder) => !tree.expanded.includes(folder));
  actions.tree(checkout, {
    expanded: [...tree.expanded, ...opening],
    focus: paths[0],
    selected: [...paths],
  });
  for (const folder of opening) actions.start(actions.list(checkout, folder));
}
