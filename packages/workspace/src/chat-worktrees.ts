import { mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ApplicationError,
  type CheckoutTarget,
  type CommandInput,
  type CommandOutput,
} from '@moonbase/contracts/workspace';
import { maximumBranchName } from '@moonbase/contracts/workspace-host-schema';
import { ensure, requireGit } from './validation.ts';

const branchPattern = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i;
/** Numbered names tried for a taken branch or location before giving up. */
const maximumAttempts = 20;

export type ChatWorktreeSteps = {
  /** Opens (approves) the checkout at `root`, as `openCheckout` does. */
  open(root: string, signal: AbortSignal): Promise<CheckoutTarget>;
  list(target: CheckoutTarget, signal: AbortSignal): Promise<CommandOutput<'listWorktrees'>>;
  create(input: CommandInput<'createWorktree'>, signal: AbortSignal): Promise<CheckoutTarget>;
  /** Refuses a parent folder the host may not make worktrees in; it may not exist yet. */
  permitParent(parent: string): Promise<void>;
};

/**
 * Where a chat's worktrees go: `<main worktree>-worktrees/<branch>`, with `/` in the branch
 * written `-` in the folder. The host derives it, so a client never names where directories are
 * made. A taken branch or location gets a numbered suffix.
 */
export class ChatWorktrees {
  private readonly steps: ChatWorktreeSteps;
  /** Attempts run one at a time per project, so two never race for a name or a parent folder. */
  private readonly attempts = new Map<string, Promise<unknown>>();
  constructor(steps: ChatWorktreeSteps) {
    this.steps = steps;
  }
  async create(
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
    const target = await this.steps.open(root, signal);
    requireGit(target);
    const previous = this.attempts.get(target.projectId) ?? Promise.resolve();
    // Cancelling while queued ends the wait; the next attempt still waits for the one running.
    const turn = new Promise<void>((done, refuse) => {
      const cancel = () => refuse(cancelledError());
      if (signal.aborted) return cancel();
      signal.addEventListener('abort', cancel, { once: true });
      void previous.then(() => {
        signal.removeEventListener('abort', cancel);
        done();
      });
    });
    const attempt = turn.then(() => this.attempt(target, branch, signal));
    const settled = Promise.all([previous, attempt.catch(() => {})]).then(() => {});
    this.attempts.set(target.projectId, settled);
    void settled.then(() => {
      if (this.attempts.get(target.projectId) === settled) this.attempts.delete(target.projectId);
    });
    return attempt;
  }
  private async attempt(target: CheckoutTarget, branch: string, signal: AbortSignal) {
    cancelled(signal);
    const { worktrees } = await this.steps.list(target, signal);
    const parent = `${worktrees.find((worktree) => worktree.main)?.root ?? target.root}-worktrees`;
    // Checked before anything is made, since the folder doesn't exist yet to check itself.
    await this.steps.permitParent(parent);
    cancelled(signal);
    const madeParent = await mkdir(parent).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
        return false;
      },
    );
    let prefix = branch;
    try {
      for (let attempt = 1; ; attempt++) {
        const name = attempt === 1 ? prefix : `${prefix}-${attempt}`;
        try {
          return await this.steps.create(
            {
              checkout: target,
              base: 'HEAD',
              branch: name,
              location: join(parent, name.replaceAll('/', '-')),
            },
            signal,
          );
        } catch (error) {
          if (!ApplicationError.is(error) || ['Cancelled', 'Uncertain'].includes(error.code))
            throw error;
          if (error.code === 'Conflict' && attempt < maximumAttempts) continue;
          // A branch named like the prefix (`chat`) blocks every `chat/…` branch, which Git
          // refuses (Unavailable): use `chat-…`. That maps to the same location, so any other
          // refusal of it would only repeat.
          if (error.code !== 'Unavailable' || !prefix.includes('/')) throw error;
          prefix = prefix.replaceAll('/', '-');
          attempt = 0;
        }
      }
    } catch (error) {
      // An empty folder this attempt made is removed; one holding other worktrees is kept.
      if (madeParent) await rmdir(parent).catch(() => {});
      throw error;
    }
  }
}

function cancelledError() {
  return new ApplicationError({ code: 'Cancelled', message: 'The worktree was not created.' });
}

function cancelled(signal: AbortSignal) {
  if (signal.aborted) throw cancelledError();
}
