import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { maximumBranchName } from '@moonbase/contracts/workspace-host-schema';
import { WorkspaceConflictError } from '@moonbase/contracts/workspace-host-errors';
import { attempt } from '../attempt.ts';
import type { Directory } from '../filesystem.ts';
import { ensure, requireGit } from '../validation.ts';
import { cancellationPoint } from './cancellation.ts';
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
    yield* attempt(() =>
      ensure(
        branchPattern.test(branch) &&
          branch.length <= maximumBranchName &&
          !branch.includes('..') &&
          !branch.endsWith('.lock'),
        'Choose a simple branch name for the worktree.',
      ),
    );
    const target = yield* Effect.interruptible(checkouts.open(root));
    yield* attempt(() => requireGit(target));
    const listed = yield* Effect.interruptible(worktrees.listWorktrees(target));
    const parent = `${listed.worktrees.find((worktree) => worktree.main)?.root ?? target.root}-worktrees`;
    // Checked before anything is made, since the folder doesn't exist yet to check itself. An empty
    // one left by a failed creation is kept for the next.
    yield* checkouts.permitContainer(parent);
    yield* cancellationPoint;
    yield* attempt(() => {
      try {
        mkdirSync(parent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    });
    const directory = yield* checkouts.directory(target);
    let prefix = branch;
    for (let tries = 1; ; tries++) {
      const name = tries === 1 ? prefix : `${prefix}-${tries}`;
      const clash = yield* Effect.interruptible(findRefClash(directory, name));
      // A branch named like one of the name's folders (`chat` for `chat/topic`) blocks it in Git:
      // use `chat-topic`, which has no folders to clash with.
      if (clash === 'folder') {
        prefix = prefix.replaceAll('/', '-');
        tries = 0;
        continue;
      }
      // Branches inside the name (`chat/topic` for `chat`) block it as a taken one would.
      const made = yield* Effect.exit(
        clash === 'inside'
          ? Effect.fail(
              new WorkspaceConflictError({ reason: `Branches inside ${name}/ already exist.` }),
            )
          : worktrees.createWorktree({
              checkout: target,
              base: 'HEAD',
              branch: name,
              location: join(parent, name.replaceAll('/', '-')),
            }),
      );
      if (made._tag === 'Success') return made.value as CheckoutTarget;
      const failure = made.cause.reasons.find((reason) => reason._tag === 'Fail');
      if (
        failure?._tag === 'Fail' &&
        failure.error instanceof WorkspaceConflictError &&
        tries < maximumAttempts
      )
        continue;
      return yield* Effect.failCause(made.cause);
    }
  });

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
