import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  ApplicationError,
  type CheckoutTarget,
  type CommandInput,
  type Worktree,
} from '@moonbase/contracts/workspace';
import { identity, type Directory } from '../filesystem.ts';
import { ensure, errorText, requireGit } from '../validation.ts';
import { fail } from '@moonbase/contracts/errors';

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
/**
 * Whether two roots are one place. macOS volumes are usually case-insensitive and ignore Unicode
 * normalization, and Git there precomposes the paths it is given.
 */
const sameRoot = (a: string, b: string) => {
  const normal = (root: string) =>
    process.platform === 'darwin' ? root.normalize('NFC').toLowerCase() : root;
  return normal(a) === normal(b);
};
const listArgs = ['worktree', 'list', '--porcelain', '-z'];

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
  private readonly protect: (location: string) => void | Promise<void>;
  /** Reports a failure that does not undo a finished creation, such as a lock left behind. */
  private readonly report: (message: string) => void;
  /** Creations run one at a time per project, so none mistakes another's worktree for its own. */
  private readonly creations = new Map<string, Promise<unknown>>();
  constructor(
    directory: (target: CheckoutTarget) => Promise<Directory>,
    open: (root: string, source: CheckoutTarget, signal: AbortSignal) => Promise<CheckoutTarget>,
    protect: (location: string) => void | Promise<void>,
    report: (message: string) => void,
  ) {
    this.directory = directory;
    this.open = open;
    this.protect = protect;
    this.report = report;
  }
  /** A plain folder has no worktrees, like a bare repository. */
  async listWorktrees(target: CheckoutTarget, signal: AbortSignal, open?: Directory) {
    const directory = open ?? (await this.directory(target));
    if (target.vcs === 'none') return { worktrees: [] };
    const output = await directory.git(listArgs, undefined, signal, { untranslated: true });
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
    requireGit(input.checkout);
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
    const parentIdentity = folderIdentity(parent);
    ensure(parentIdentity, 'The worktree location parent must be a folder.');
    // Git precomposes the paths it is given, so the folder it makes is named in NFC.
    const location = join(parent, basename(input.location).normalize('NFC'));
    await this.protect(location);
    if (exists(location)) fail('Conflict', 'The worktree location already exists.');
    // A worktree whose folder is missing (moved, or on an unmounted drive) still owns its location.
    const before = readWorktrees(
      (await directory.git(listArgs, undefined, signal, { untranslated: true })).toString(),
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
    // The empty old value creates the branch only if it does not exist, and the reflog entry and
    // the new worktree's lock reason name this creation, so cleanup removes only what it made.
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
      // Stopped mid-write (cancelled or at the time limit), the branch may be this creation's.
      const cleanup =
        signal.aborted || gitFailure(made).uncertain
          ? await this.removeBranch(directory, created, false)
          : undefined;
      if (cleanup)
        fail(
          'Uncertain',
          `Worktree creation stopped and cleanup is incomplete (${cleanup}). Inspect branch ${branch}.`,
        );
      if (signal.aborted) fail('Cancelled', 'Worktree creation cancelled; nothing was kept.');
      throw asCreationFailure(made);
    }
    let target: CheckoutTarget;
    try {
      // A parent swapped for a link since it was checked would put the worktree elsewhere.
      ensure(
        folderIdentity(parent) === parentIdentity,
        'The worktree location parent changed. Choose the location again.',
      );
      // Locked from its start until approved, with a reason only this creation knows.
      await directory.git(
        ['worktree', 'add', '--quiet', '--lock', '--reason', created.nonce, '--', location, branch],
        undefined,
        signal,
      );
      target = await this.open(location, input.checkout, signal);
    } catch (error) {
      const cleanup = await this.removeCreated(
        directory,
        location,
        parentIdentity,
        before,
        created,
      );
      if (cleanup)
        fail(
          'Uncertain',
          `Worktree creation failed and cleanup is incomplete (${cleanup}). Inspect ${location} and branch ${branch}. ${failureText(error)}`,
        );
      if (signal.aborted) fail('Cancelled', 'Worktree creation cancelled; nothing was kept.');
      throw asCreationFailure(error);
    }
    // The worktree is approved and kept: a lock left behind is reported but does not undo it.
    const unlock = () => directory.git(['worktree', 'unlock', '--', location]);
    await unlock()
      .catch(unlock)
      .catch((error) =>
        this.report(
          `Worktree ${location} was created but is still locked (${failureText(error)}). Run git worktree unlock on it.`,
        ),
      );
    return target;
  }
  /**
   * Removes only what this creation added: the worktree registered at `location` since `before`
   * that still holds this creation's lock, on its branch at its commit, then that branch.
   * Anything else at the location is left for inspection.
   */
  private async removeCreated(
    directory: Directory,
    location: string,
    parentIdentity: string,
    before: WorktreeRecord[],
    created: CreatedBranch,
  ): Promise<string | undefined> {
    try {
      const listed = await directory.git(listArgs, undefined, undefined, { untranslated: true });
      const registered = readWorktrees(listed.toString()).find((worktree) =>
        sameRoot(worktree.root, location),
      );
      if (registered) {
        // Another tool or terminal may have added its own worktree here since the snapshot.
        if (
          before.some((worktree) => sameRoot(worktree.root, location)) ||
          registered.lockReason !== created.nonce ||
          registered.ref !== created.ref ||
          registered.head !== created.commit
        )
          return 'another worktree is at the location';
        // Through a parent swapped for a link, the removal would reach another folder.
        if (folderIdentity(dirname(location)) !== parentIdentity)
          return 'the location parent changed';
        // Still locked by this creation, it holds nothing but this creation's checkout (perhaps
        // partial) and what its hooks wrote: remove it despite the lock and any changes.
        await directory.git(['worktree', 'remove', '--force', '--force', '--', location]);
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
    const resolveRef = () =>
      directory
        .git(['rev-parse', '--verify', '--quiet', '--end-of-options', ref])
        .then((output) => output.toString().trim())
        .catch(() => '');
    try {
      // A symbolic ref names another branch, which deleting through it would remove.
      const symbolic = await directory.git(['symbolic-ref', '-q', ref]).then(
        () => true,
        () => false,
      );
      if (symbolic) return 'the branch was replaced by a symbolic ref';
      const current = await resolveRef();
      if (!current) return undefined;
      // A branch that moved is someone's work; one this creation did not make is theirs.
      if (current !== commit) return made ? 'the branch has moved since it was made' : undefined;
      const latest = await directory
        .git(['log', '-g', '-n', '1', '--format=%H%x00%gs', '--end-of-options', ref, '--'])
        .then((output) => output.toString().trim())
        .catch(() => undefined);
      if (latest === `${commit}\0${nonce}`) {
        await directory.git(['update-ref', '--no-deref', '-d', ref, commit]).catch(() => undefined);
        return (await resolveRef()) === commit ? 'branch still exists' : undefined;
      }
      if (!made && latest) return undefined;
      return 'branch still exists and its reflog does not confirm this creation made it';
    } catch (error) {
      return failureText(error);
    }
  }
}

/** A folder's identity, or undefined when the path is not a folder itself (a link, say). */
function folderIdentity(path: string) {
  try {
    const info = lstatSync(path);
    return info.isDirectory() ? identity(info) : undefined;
  } catch {
    return undefined;
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
