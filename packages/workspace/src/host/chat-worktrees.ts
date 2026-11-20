import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Schedule, Schema } from 'effect';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { maximumBranchName } from '@moonbase/contracts/workspace-host-schema';
import { BranchTakenError, InvalidRequestError } from '@moonbase/contracts/workspace-host-errors';
import { systemCall } from '../system-failures.ts';
import type { Directory } from '../filesystem.ts';
import { requireGit } from '../validation.ts';
import { cancellationPoint } from '../cancellation.ts';
import { Checkouts } from './checkouts.ts';
import { WorkspaceWorktrees } from './worktrees.ts';

const branchPattern = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i;
/** Numbered names tried for a taken branch or location before giving up. */
const maximumAttempts = 20;

/**
 * Makes a chat's worktree at `<main worktree>-worktrees/<branch>`, with `/` in the branch written
 * `-` in the folder. The host derives the location, so a client never names where directories are
 * made. A taken branch or location gets a numbered suffix; `createWorktree` runs one creation per
 * project at a time, so two never race for a name.
 */
export const makeChatWorktree = ({ root, branch }: { root: string; branch: string }) =>
  Effect.gen(function* () {
    const checkouts = yield* Checkouts;
    const worktrees = yield* WorkspaceWorktrees;
    if (
      !(
        branchPattern.test(branch) &&
        branch.length <= maximumBranchName &&
        !branch.includes('..') &&
        !branch.endsWith('.lock')
      )
    )
      return yield* new InvalidRequestError({ problem: 'chat-branch-name' });
    const target = yield* Effect.interruptible(checkouts.open(root));
    yield* requireGit(target);
    const listed = yield* Effect.interruptible(worktrees.listWorktrees(target));
    const parent = `${listed.worktrees.find((worktree) => worktree.main)?.root ?? target.root}-worktrees`;
    // Checked before anything is made, since the folder doesn't exist yet to check itself. An empty
    // one left by a failed creation is kept for the next.
    yield* checkouts.permitNewFolder(parent);
    yield* cancellationPoint;
    yield* systemCall(() => mkdirSync(parent)).pipe(
      Effect.catchTag('SystemFailure', (failure) =>
        failure.code === 'EEXIST' ? Effect.void : Effect.fail(failure),
      ),
    );
    const directory = yield* checkouts.directory(target);
    /** Creates the worktree under `prefix`, then `prefix-2`, `prefix-3` and so on while taken. */
    const createNumbered = (prefix: string) =>
      Effect.suspend(() => {
        let tries = 0;
        return Effect.suspend(() => {
          tries++;
          return createNamed(tries === 1 ? prefix : `${prefix}-${tries}`);
        }).pipe(
          Effect.retry({
            schedule: Schedule.recurs(maximumAttempts - 1),
            // A taken branch or location: try the next name.
            while: (error) =>
              error._tag === 'BranchTakenError' || error._tag === 'WorkspaceConflictError',
          }),
        );
      });
    const createNamed = (name: string) =>
      Effect.gen(function* () {
        const clash = yield* Effect.interruptible(findRefClash(directory, name));
        // A branch named like one of the name's folders (`chat` for `chat/topic`) blocks it in
        // Git, and every numbered name too: use `chat-topic`, which has no folders to clash with.
        if (clash === 'folder') return yield* new FolderClash();
        // Branches inside the name (`chat/topic` for `chat`) block it as a taken one would.
        if (clash === 'inside') return yield* new BranchTakenError({ inside: true });
        return (yield* worktrees.createWorktree({
          checkout: target,
          base: 'HEAD',
          branch: name,
          location: join(parent, name.replaceAll('/', '-')),
        })) as CheckoutTarget;
      });
    return yield* createNumbered(branch).pipe(
      Effect.catchTag('FolderClash', () =>
        createNumbered(branch.replaceAll('/', '-')).pipe(
          // A name with no folders has none to clash with.
          Effect.catchTag('FolderClash', (clash) => Effect.die(clash)),
        ),
      ),
    );
  });

/** A branch named like one of a chat branch's folders blocks it; never leaves this module. */
class FolderClash extends Schema.TaggedError<FolderClash>()('FolderClash', {}) {
  override get message() {
    return 'A branch is named like a folder of the chat branch.';
  }
}

/**
 * How existing branches block `name` as a folder/file clash in Git's ref store: one named like a
 * folder of it (`folder`), or ones inside it (`inside`).
 */
const findRefClash = (directory: Directory, name: string) =>
  Effect.gen(function* () {
    const parts = name.split('/');
    const folders = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
    // A pattern matches its ref and every ref inside it.
    const listed = (yield* directory.git([
      'for-each-ref',
      '--format=%(refname)',
      ...[...folders, name].map((n) => `refs/heads/${n}`),
    ]))
      .toString()
      .split('\n');
    if (listed.some((ref) => folders.some((folder) => ref === `refs/heads/${folder}`)))
      return 'folder' as const;
    if (listed.some((ref) => ref.startsWith(`refs/heads/${name}/`))) return 'inside' as const;
    return undefined;
  });
