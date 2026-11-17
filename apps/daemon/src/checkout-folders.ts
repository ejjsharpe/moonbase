import { Effect } from 'effect';
import type { FolderApprovals } from '@moonbase/contracts/daemon';

/**
 * A local-mode daemon's folders plus its workspace's: chats may also use a folder that `checkouts`
 * says is the root of an approved checkout. Only `has` widens. Picker approvals, the recent list
 * and `approve` are the picker's alone, so a project the editor opened is never offered again as a
 * recent folder. A `checkouts` that fails approves nothing.
 */
export const withCheckoutFolders = (
  folders: FolderApprovals,
  checkouts: { has(path: string): Effect.Effect<boolean, unknown> },
): FolderApprovals => ({
  ...folders,
  has: (path) =>
    Effect.flatMap(folders.has(path), (approved) =>
      approved
        ? Effect.succeed(true)
        : checkouts.has(path).pipe(
            Effect.orElseSucceed(() => false),
            Effect.catchDefect(() => Effect.succeed(false)),
          ),
    ),
});
