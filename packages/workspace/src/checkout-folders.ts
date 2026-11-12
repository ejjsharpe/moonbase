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
  /** Refuses a root the host's reserved paths or root policy do not allow, as opening it would. */
  permit(root: string): Promise<void>;
  /** The root's `.git` entry: a folder (`pointer: null`) or a file naming the repository. */
  gitEntry(root: string): { pointer: string | null } | null;
};

/** How long one approved repository may take to answer; a check allows three such budgets in all. */
const defaultDeadlineMs = 10_000;
const repositoriesPerCheck = 3;

/** Settles with `fallback` once `signal` aborts, so a step that never answers cannot hold the check. */
function until<T>(signal: AbortSignal, promise: Promise<T>, fallback: T): Promise<T> {
  if (signal.aborted) return Promise.resolve(fallback);
  return new Promise<T>((resolve) => {
    const abort = () => resolve(fallback);
    signal.addEventListener('abort', abort, { once: true });
    promise
      .then(resolve, () => resolve(fallback))
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

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
  private readonly deadlineMs: number;
  constructor(steps: CheckoutFolderSteps, deadlineMs = defaultDeadlineMs) {
    this.steps = steps;
    this.deadlineMs = deadlineMs;
  }
  async has(path: string, signal: AbortSignal): Promise<boolean> {
    const approvals = this.steps.approvals();
    const named = approvals.filter((approval) => approval.target.root === path);
    // A root spelled differently from its real path, or no longer a directory, is not a folder.
    if (!isDirectoryNamedByRealPath(path)) return false;
    // A total cap bounds the whole check and each repository has its own budget, so a hung
    // repository cannot starve a healthy one yet many cannot stall the check. Running out of time
    // is "not a folder".
    const total = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.deadlineMs * repositoriesPerCheck),
    ]);
    for (const approval of named) if (await this.holds(approval.target, total)) return true;
    // One approved checkout per repository is enough to ask Git for its worktrees.
    const asked = new Set<string>();
    for (const approval of approvals) {
      const common = approval.common;
      if (!common || asked.has(common.path) || approval.target.vcs !== 'git') continue;
      if (total.aborted) return false;
      const budget = AbortSignal.any([total, AbortSignal.timeout(this.deadlineMs)]);
      const found = await until(budget, this.findIn(approval, common, path, budget), false);
      if (found) return true;
      // A repository that ran out of its budget is not asked again by a later approval.
      asked.add(common.path);
    }
    return false;
  }
  private async findIn(
    approval: Approval,
    common: { path: string },
    path: string,
    budget: AbortSignal,
  ) {
    if (!(await this.holds(approval.target, budget))) return false;
    const listed = await this.steps.list(approval.target, budget).catch(() => []);
    for (const worktree of listed)
      if (worktree.root === path && (await this.belongs(path, worktree, common, budget)))
        return true;
    return false;
  }
  private holds(target: CheckoutTarget, deadline: AbortSignal) {
    return until(
      deadline,
      this.steps.verify(target).then(() => true),
      false,
    );
  }
  /**
   * Whether the folder Git lists is still that worktree of the repository: its main working tree
   * has the repository's own `.git` folder, a linked one a `.git` file pointing into the
   * repository's `worktrees/` folder whose `gitdir` points back at this folder.
   */
  private belongs(
    path: string,
    worktree: Worktree,
    common: { path: string },
    deadline: AbortSignal,
  ) {
    return until(deadline, this.checkBelongs(path, worktree, common), false);
  }
  private async checkBelongs(path: string, worktree: Worktree, common: { path: string }) {
    try {
      // Git lists what a repository's files say, so the folder meets the same policy as an opened one.
      await this.steps.permit(path);
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
