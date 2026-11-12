import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { CheckoutTarget, Worktree } from '@moonbase/contracts/workspace';
import type { Approval } from './schema.ts';

export type CheckoutFolderSteps = {
  approvals(): Approval[];
  /** Re-checks an approved checkout's identity and policy; throws once it no longer holds. */
  verify(target: CheckoutTarget): Promise<void>;
  /** Lists the worktrees without keeping the checkout open. */
  list(target: CheckoutTarget, signal: AbortSignal): Promise<Worktree[]>;
  /** The root's `.git` entry: a folder (`pointer: null`) or a file naming the repository. */
  gitEntry(root: string): { pointer: string | null } | null;
};

/** How long Git may take to list one repository's worktrees for a folder check. */
const listDeadlineMs = 10_000;

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
    // A newer approval of the same root supersedes the older ones, which match nothing.
    const newest = new Map<string, Approval>();
    for (const approval of this.steps.approvals()) newest.set(approval.target.root, approval);
    const approvals = [...newest.values()];
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
      // A repository that does not answer in time is not a folder source; it must not stall the check.
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(listDeadlineMs)]);
      const listed = await this.steps.list(approval.target, deadline).catch(() => []);
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
   * repository's `worktrees/` folder whose `gitdir` points back at this folder.
   */
  private belongs(path: string, worktree: Worktree, common: { path: string }) {
    try {
      const entry = this.steps.gitEntry(path);
      if (!entry) return false;
      if (worktree.main)
        return entry.pointer === null && realPath(join(path, '.git')) === common.path;
      const match = /^gitdir: (.+?)\s*$/.exec(entry.pointer ?? '');
      const linked = match && realPath(resolve(path, match[1]!));
      if (
        !linked ||
        basename(dirname(linked)) !== 'worktrees' ||
        dirname(dirname(linked)) !== common.path
      )
        return false;
      // The admin folder must point back at this folder, or another worktree's would pass.
      const back = readFileSync(join(linked, 'gitdir'), 'utf8').trim();
      return realPath(resolve(linked, back)) === realPath(join(path, '.git'));
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
