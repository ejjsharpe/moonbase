import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  ApplicationError,
  type CheckoutTarget,
  type CommandInput,
  type Worktree,
} from '@moonbase/contracts/workspace';
import type { Directory } from './filesystem.ts';
import { errorText } from './recovery.ts';
import { ensure, fail } from './validation.ts';

const gitFailure = (error: unknown) =>
  error as { status?: number; uncertain?: boolean; stderr?: string };
const failureText = (error: unknown) => gitFailure(error)?.stderr?.trim() || errorText(error);
const branchName = (head: string | undefined, ref: string | undefined) =>
  ref?.startsWith('refs/heads/')
    ? ref.slice('refs/heads/'.length)
    : (head ?? '').slice(0, 7) + ' (detached)';
/**
 * A worktree root as a real path in its on-disk spelling (Git keeps paths as typed); a missing
 * one resolves through its parent.
 */
const realRoot = (root: string) => {
  try {
    return realpathSync.native(root);
  } catch {
    try {
      return join(realpathSync.native(dirname(root)), basename(root));
    } catch {
      return root;
    }
  }
};
/** macOS volumes are usually case-insensitive, so roots differing only in case are one place. */
const sameRoot = (a: string, b: string) =>
  process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
/** The lock reason `git worktree add` writes until its checkout completes. */
const initializing = 'initializing';

type WorktreeRecord = Worktree & {
  lockReason: string | undefined;
  ref: string | undefined;
  head: string | undefined;
};

function readWorktrees(output: string): WorktreeRecord[] {
  const records: Map<string, string>[] = [];
  let current: Map<string, string> | undefined;
  for (const field of output.split('\0')) {
    if (!field) {
      current = undefined;
      continue;
    }
    const space = field.indexOf(' ');
    const name = space < 0 ? field : field.slice(0, space);
    const value = space < 0 ? '' : field.slice(space + 1);
    if (name === 'worktree') records.push((current = new Map()));
    current?.set(name, value);
  }
  return records.flatMap((record, index) =>
    record.has('bare') || !isAbsolute(record.get('worktree') ?? '')
      ? []
      : [
          {
            root: realRoot(record.get('worktree')!),
            branch: branchName(record.get('HEAD'), record.get('branch')),
            main: index === 0,
            locked: record.has('locked'),
            prunable: record.has('prunable'),
            lockReason: record.get('locked'),
            ref: record.get('branch'),
            head: record.get('HEAD'),
          },
        ],
  );
}

/** Parses `git worktree list --porcelain -z`; the first non-bare record is the main working tree. */
export function parseWorktrees(output: string): Worktree[] {
  return readWorktrees(output).map(({ root, branch, main, locked, prunable }) => ({
    root,
    branch,
    main,
    locked,
    prunable,
  }));
}

type CreatedBranch = { ref: string; commit: string; nonce: string };

export class WorkspaceWorktrees {
  private readonly directory: (target: CheckoutTarget) => Promise<Directory>;
  /**
   * Approves the checkout a creation from `source` just made at `root`, superseding any stale
   * approval of that root.
   */
  private readonly open: (
    root: string,
    source: CheckoutTarget,
    signal: AbortSignal,
  ) => Promise<CheckoutTarget>;
  private readonly protect: (root: string) => void;
  /** Creations run one at a time per project, so none mistakes another's worktree for its own. */
  private readonly creations = new Map<string, Promise<unknown>>();
  constructor(
    directory: (target: CheckoutTarget) => Promise<Directory>,
    open: (root: string, source: CheckoutTarget, signal: AbortSignal) => Promise<CheckoutTarget>,
    protect: (root: string) => void,
  ) {
    this.directory = directory;
    this.open = open;
    this.protect = protect;
  }
  async listWorktrees(target: CheckoutTarget, signal: AbortSignal) {
    const directory = await this.directory(target);
    const output = await directory.git(
      ['worktree', 'list', '--porcelain', '-z'],
      undefined,
      signal,
    );
    return { worktrees: parseWorktrees(output.toString()).slice(0, 1000) };
  }
  /** Creates `branch` at `base` in a new linked worktree at `location`, then approves and opens it. */
  createWorktree(input: CommandInput<'createWorktree'>, signal: AbortSignal) {
    const key = input.checkout.projectId;
    const previous = this.creations.get(key) ?? Promise.resolve();
    // Cancelling while queued ends the wait; the next creation still waits for the one running.
    const turn = new Promise<void>((done, refuse) => {
      const cancel = () =>
        refuse(
          new ApplicationError({
            code: 'Cancelled',
            message: 'Worktree creation cancelled; nothing was kept.',
          }),
        );
      if (signal.aborted) return cancel();
      signal.addEventListener('abort', cancel, { once: true });
      void previous.then(() => {
        signal.removeEventListener('abort', cancel);
        done();
      });
    });
    const creation = turn.then(() => this.createNow(input, signal));
    const settled = Promise.all([previous, creation.catch(() => {})]).then(() => {});
    this.creations.set(key, settled);
    void settled.then(() => {
      if (this.creations.get(key) === settled) this.creations.delete(key);
    });
    return creation;
  }
  private async createNow(input: CommandInput<'createWorktree'>, signal: AbortSignal) {
    if (signal.aborted) fail('Cancelled', 'Worktree creation cancelled; nothing was kept.');
    const directory = await this.directory(input.checkout);
    const { base, branch } = input;
    ensure(
      isAbsolute(input.location) &&
        resolve(input.location) === input.location &&
        basename(input.location) !== '',
      'Choose an absolute worktree location without traversal.',
    );
    let parent: string;
    try {
      parent = realpathSync.native(dirname(input.location));
    } catch {
      return fail('InvalidInput', 'The worktree location parent folder does not exist.');
    }
    ensure(lstatSync(parent).isDirectory(), 'The worktree location parent must be a folder.');
    const location = join(parent, basename(input.location));
    this.protect(location);
    if (exists(location)) fail('Conflict', 'The worktree location already exists.');
    // A worktree whose folder is missing (moved, or on an unmounted drive) still owns its location.
    const before = readWorktrees(
      (
        await directory.git(['worktree', 'list', '--porcelain', '-z'], undefined, signal)
      ).toString(),
    );
    if (before.some((worktree) => sameRoot(worktree.root, location)))
      fail('Conflict', 'Another worktree is registered at the worktree location.');
    const formatted = await directory
      .git(['check-ref-format', '--branch', branch], undefined, signal)
      .then((output) => output.toString().trim())
      .catch(() => '');
    ensure(formatted === branch, 'Invalid branch name.');
    const ref = 'refs/heads/' + branch;
    const existing = await directory
      .git(['show-ref', '--verify', '--quiet', ref], undefined, signal)
      .then(
        () => true,
        (error) => {
          if (gitFailure(error).status === 1 && !gitFailure(error).uncertain) return false;
          throw error;
        },
      );
    if (existing) fail('Conflict', `Branch ${branch} already exists.`);
    const commit = await directory
      .git(
        ['rev-parse', '--verify', '--quiet', '--end-of-options', base + '^{commit}'],
        undefined,
        signal,
      )
      .then((output) => output.toString().trim())
      .catch(() => '');
    ensure(/^[a-f0-9]{40,64}$/.test(commit), `Base ${base} is not a commit.`);
    // The empty old value creates the branch only if it does not exist, and the reflog entry
    // names this creation, so cleanup deletes only a branch this creation made.
    const created = { ref, commit, nonce: `moonbase: create worktree ${randomUUID()}` };
    const made = await directory
      .git(
        ['update-ref', '--create-reflog', '-m', created.nonce, ref, commit, ''],
        undefined,
        signal,
      )
      .then(
        () => true,
        (error) => error,
      );
    if (made !== true) {
      // Stopped mid-write, the branch may be this creation's after all.
      const cleanup = signal.aborted
        ? await this.removeBranch(directory, created, false)
        : undefined;
      if (cleanup)
        fail(
          'Uncertain',
          `Worktree creation was cancelled and cleanup is incomplete (${cleanup}). Inspect branch ${branch}.`,
        );
      if (signal.aborted) fail('Cancelled', 'Worktree creation cancelled; nothing was kept.');
      throw asCreationFailure(made);
    }
    try {
      await directory.git(
        ['worktree', 'add', '--quiet', '--', location, branch],
        undefined,
        signal,
      );
      return await this.open(location, input.checkout, signal);
    } catch (error) {
      const cleanup = await this.removeCreated(directory, location, before, created);
      if (cleanup)
        fail(
          'Uncertain',
          `Worktree creation failed and cleanup is incomplete (${cleanup}). Inspect ${location} and branch ${branch}. ${failureText(error)}`,
        );
      if (signal.aborted) fail('Cancelled', 'Worktree creation cancelled; nothing was kept.');
      throw asCreationFailure(error);
    }
  }
  /**
   * Removes only what this creation added: the worktree registered at `location` since `before`
   * on the branch it created, still at its commit (clean, or still locked by Git's own unfinished
   * checkout), then that branch. Anything else at the location is left for inspection.
   */
  private async removeCreated(
    directory: Directory,
    location: string,
    before: WorktreeRecord[],
    created: CreatedBranch,
  ): Promise<string | undefined> {
    try {
      const listed = await directory.git(['worktree', 'list', '--porcelain', '-z']);
      const registered = readWorktrees(listed.toString()).find((worktree) =>
        sameRoot(worktree.root, location),
      );
      if (registered) {
        // Another tool or terminal may have added its own worktree here since the snapshot.
        if (
          before.some((worktree) => sameRoot(worktree.root, location)) ||
          registered.ref !== created.ref ||
          registered.head !== created.commit
        )
          return 'another worktree is at the location';
        // Git keeps a new worktree locked as `initializing` until its checkout completes, so
        // such a worktree holds nothing but this creation's partial checkout: remove it despite
        // the lock. Any other is removed only while clean and unlocked.
        await directory.git([
          'worktree',
          'remove',
          ...(registered.locked && registered.lockReason === initializing
            ? ['--force', '--force']
            : []),
          '--',
          location,
        ]);
      }
      // A checkout left at the location may still use the branch, so both are kept.
      if (exists(location)) return 'location still exists';
      return await this.removeBranch(directory, created, true);
    } catch (error) {
      return failureText(error);
    }
  }
  /**
   * Deletes the branch this creation made while it is unchanged: still at its commit, with this
   * creation's reflog entry the latest. `made` says the create-only update succeeded; otherwise a
   * branch whose reflog names someone else is theirs and is kept without complaint.
   */
  private async removeBranch(
    directory: Directory,
    { ref, commit, nonce }: CreatedBranch,
    made: boolean,
  ): Promise<string | undefined> {
    try {
      const current = await directory
        .git(['rev-parse', '--verify', '--quiet', '--end-of-options', ref])
        .then((output) => output.toString().trim())
        .catch(() => '');
      if (current !== commit) return undefined;
      const latest = await directory
        .git(['log', '-g', '-n', '1', '--format=%H%x00%gs', '--end-of-options', ref, '--'])
        .then((output) => output.toString().trim())
        .catch(() => undefined);
      if (latest === `${commit}\0${nonce}`) {
        await directory.git(['update-ref', '-d', ref, commit]).catch(() => undefined);
        const remaining = await directory
          .git(['rev-parse', '--verify', '--quiet', '--end-of-options', ref])
          .then((output) => output.toString().trim())
          .catch(() => '');
        return remaining === commit ? 'branch still exists' : undefined;
      }
      if (!made && latest) return undefined;
      return 'branch still exists and its reflog does not confirm this creation made it';
    } catch (error) {
      return failureText(error);
    }
  }
}

function exists(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function asCreationFailure(error: unknown) {
  return ApplicationError.is(error)
    ? error
    : new ApplicationError({
        code: 'Unavailable',
        message: 'Git could not create the worktree. ' + failureText(error),
      });
}
