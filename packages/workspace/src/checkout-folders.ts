import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { CheckoutTarget, Worktree } from '@moonbase/contracts/workspace';
import type { Approval } from './schema.ts';

export type CheckoutFolderSteps = {
  approvals(): Approval[];
  /** Re-checks an approved checkout's identity and policy; throws once it no longer holds. */
  verify(target: CheckoutTarget): Promise<void>;
  list(target: CheckoutTarget, signal: AbortSignal): Promise<Worktree[]>;
  /** The root's `.git` entry: a folder (`pointer: null`) or a file naming the repository. */
  gitEntry(root: string): { pointer: string | null } | null;
};

const realPath = (path: string) => {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
};

/**
 * Whether a folder is one the host approved as a checkout root, or a worktree Git lists for an
 * approved Git checkout. Nothing is stored or approved by asking: each call checks the identity
 * again, so a checkout replaced since it was approved, or a worktree folder swapped for another
 * directory, is not a folder.
 */
export class CheckoutFolders {
  private readonly steps: CheckoutFolderSteps;
  constructor(steps: CheckoutFolderSteps) {
    this.steps = steps;
  }
  async has(path: string, signal: AbortSignal): Promise<boolean> {
    const approvals = this.steps.approvals();
    const named = approvals.filter((approval) => approval.target.root === path);
    // A root spelled differently from its real path, or no longer a directory, is not a folder.
    if (!isDirectoryNamedByRealPath(path)) return false;
    for (const approval of named) if (await this.holds(approval.target)) return true;
    // One approved checkout per repository is enough to ask Git for its worktrees.
    const asked = new Set<string>();
    for (const approval of approvals) {
      const common = approval.common;
      if (!common || asked.has(common.path) || approval.target.vcs !== 'git') continue;
      if (!(await this.holds(approval.target))) continue;
      asked.add(common.path);
      const listed = await this.steps.list(approval.target, signal).catch(() => []);
      if (listed.some((worktree) => worktree.root === path && this.belongs(path, worktree, common)))
        return true;
    }
    return false;
  }
  private async holds(target: CheckoutTarget) {
    try {
      await this.steps.verify(target);
      return true;
    } catch {
      return false;
    }
  }
  /**
   * Whether the folder Git lists is still that worktree of the repository: its main working tree
   * has the repository's own `.git` folder, a linked one a `.git` file pointing into the
   * repository's `worktrees/` folder.
   */
  private belongs(path: string, worktree: Worktree, common: { path: string }) {
    try {
      const entry = this.steps.gitEntry(path);
      if (!entry) return false;
      if (worktree.main)
        return entry.pointer === null && realPath(join(path, '.git')) === common.path;
      const match = /^gitdir: (.+?)\s*$/.exec(entry.pointer ?? '');
      const linked = match && realPath(resolve(path, match[1]!));
      return (
        !!linked &&
        basename(dirname(linked)) === 'worktrees' &&
        dirname(dirname(linked)) === common.path
      );
    } catch {
      return false;
    }
  }
}

function isDirectoryNamedByRealPath(path: string) {
  try {
    return realPath(path) === path && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
