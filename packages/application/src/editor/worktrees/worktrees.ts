/** The worktree roots last listed for one checkout. */
export type ListedWorktrees = { readonly checkoutId: string; readonly roots: readonly string[] };

/** The checkout's listed roots with `root` added, as one made since the listing. */
export function addWorktreeRoot(
  listed: ListedWorktrees | null,
  checkoutId: string,
  root: string,
): ListedWorktrees {
  const roots = listed?.checkoutId === checkoutId ? listed.roots : [];
  return roots.includes(root) && listed ? listed : { checkoutId, roots: [...roots, root] };
}
