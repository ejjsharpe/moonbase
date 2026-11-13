import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ApplicationError, type CheckoutTarget } from '@moonbase/contracts/workspace';
import { maximumBranchName } from '@moonbase/contracts/workspace-host';
import type { Directory } from '../../shared/filesystem.ts';
import type { FileHost } from '../file-host.ts';
import { ensure, requireGit } from '../../shared/validation.ts';
import { fail } from '@moonbase/contracts/errors';

const branchPattern = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i;
/** Numbered names tried for a taken branch or location before giving up. */
const maximumAttempts = 20;

/**
 * Makes a chat's worktree at `<main worktree>-worktrees/<branch>`, with `/` in the branch written
 * `-` in the folder. The host derives the location, so a client never names where directories are
 * made. A taken branch or location gets a numbered suffix; `createWorktree` runs one creation per
 * project at a time, so two never race for a name.
 */
export async function makeChatWorktree(
  host: Pick<FileHost, 'open' | 'directory' | 'worktrees' | 'permitContainer'>,
  { root, branch }: { root: string; branch: string },
  signal: AbortSignal,
): Promise<CheckoutTarget> {
  ensure(
    branchPattern.test(branch) &&
      branch.length <= maximumBranchName &&
      !branch.includes('..') &&
      !branch.endsWith('.lock'),
    'Choose a simple branch name for the worktree.',
  );
  const target = await host.open(root, signal);
  requireGit(target);
  const { worktrees } = await host.worktrees.listWorktrees(target, signal);
  const parent = `${worktrees.find((worktree) => worktree.main)?.root ?? target.root}-worktrees`;
  // Checked before anything is made, since the folder doesn't exist yet to check itself. An empty
  // one left by a failed creation is kept for the next.
  await host.permitContainer(parent);
  if (signal.aborted) fail('Cancelled', 'The worktree was not created.');
  await mkdir(parent).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const directory = await host.directory(target);
  let prefix = branch;
  for (let attempt = 1; ; attempt++) {
    const name = attempt === 1 ? prefix : `${prefix}-${attempt}`;
    const clash = await findRefClash(directory, name, signal);
    // A branch named like one of the name's folders (`chat` for `chat/topic`) blocks it in Git:
    // use `chat-topic`, which has no folders to clash with.
    if (clash === 'folder') {
      prefix = prefix.replaceAll('/', '-');
      attempt = 0;
      continue;
    }
    try {
      // Branches inside the name (`chat/topic` for `chat`) block it as a taken one would.
      if (clash === 'inside') fail('Conflict', `Branches inside ${name}/ already exist.`);
      return await host.worktrees.createWorktree(
        {
          checkout: target,
          base: 'HEAD',
          branch: name,
          location: join(parent, name.replaceAll('/', '-')),
        },
        signal,
      );
    } catch (error) {
      if (ApplicationError.is(error) && error.code === 'Conflict' && attempt < maximumAttempts)
        continue;
      throw error;
    }
  }
}

/**
 * How existing branches block `name` as a folder/file clash in Git's ref store: one named like a
 * folder of it (`folder`), or ones inside it (`inside`).
 */
async function findRefClash(
  directory: Directory,
  name: string,
  signal: AbortSignal,
): Promise<'folder' | 'inside' | undefined> {
  const parts = name.split('/');
  const folders = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
  // A pattern matches its ref and every ref inside it.
  const listed = (
    await directory.git(
      ['for-each-ref', '--format=%(refname)', ...[...folders, name].map((n) => `refs/heads/${n}`)],
      undefined,
      signal,
    )
  )
    .toString()
    .split('\n');
  if (listed.some((ref) => folders.some((folder) => ref === `refs/heads/${folder}`)))
    return 'folder';
  if (listed.some((ref) => ref.startsWith(`refs/heads/${name}/`))) return 'inside';
  return undefined;
}
