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
import { ensure, fail, requireGit } from './validation.ts';

const gitFailure = (error: unknown) =>
  error as { status?: number; uncertain?: boolean; stderr?: string };
const failureText = (error: unknown) => gitFailure(error)?.stderr?.trim() || errorText(error);
const branchName = (head: string | undefined, ref: string | undefined) =>
  ref?.startsWith('refs/heads/')
    ? ref.slice('refs/heads/'.length)
    : (head ?? '').slice(0, 7) + ' (detached)';
const realRoot = (root: string) => {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
};

/** Parses `git worktree list --porcelain -z`; the first non-bare record is the main working tree. */
export function parseWorktrees(output: string): Worktree[] {
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
          },
        ],
  );
}

export class WorkspaceWorktrees {
  private readonly directory: (target: CheckoutTarget) => Promise<Directory>;
  private readonly open: (root: string, signal: AbortSignal) => Promise<CheckoutTarget>;
  private readonly protect: (root: string) => void;
  constructor(
    directory: (target: CheckoutTarget) => Promise<Directory>,
    open: (root: string, signal: AbortSignal) => Promise<CheckoutTarget>,
    protect: (root: string) => void,
  ) {
    this.directory = directory;
    this.open = open;
    this.protect = protect;
  }
  /** A plain folder has no worktrees, like a bare repository. */
  async listWorktrees(target: CheckoutTarget, signal: AbortSignal) {
    const directory = await this.directory(target);
    if (target.vcs === 'none') return { worktrees: [] };
    const output = await directory.git(
      ['worktree', 'list', '--porcelain', '-z'],
      undefined,
      signal,
    );
    return { worktrees: parseWorktrees(output.toString()).slice(0, 1000) };
  }
  /** Creates `branch` at `base` in a new linked worktree at `location`, then approves and opens it. */
  async createWorktree(input: CommandInput<'createWorktree'>, signal: AbortSignal) {
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
      parent = realpathSync(dirname(input.location));
    } catch {
      return fail('InvalidInput', 'The worktree location parent folder does not exist.');
    }
    ensure(lstatSync(parent).isDirectory(), 'The worktree location parent must be a folder.');
    const location = join(parent, basename(input.location));
    this.protect(location);
    if (exists(location)) fail('Conflict', 'The worktree location already exists.');
    const formatted = await directory
      .git(['check-ref-format', '--branch', branch], undefined, signal)
      .then((output) => output.toString().trim())
      .catch(() => '');
    ensure(formatted === branch, 'Invalid branch name.');
    const existing = await directory
      .git(['show-ref', '--verify', '--quiet', 'refs/heads/' + branch], undefined, signal)
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
    try {
      await directory.git(
        ['worktree', 'add', '--quiet', '-b', branch, '--', location, commit],
        undefined,
        signal,
      );
      return await this.open(location, signal);
    } catch (error) {
      const cleanup = await this.removeCreated(directory, location, branch, commit);
      if (cleanup)
        fail(
          'Uncertain',
          `Worktree creation failed and cleanup is incomplete (${cleanup}). Inspect ${location} and branch ${branch}. ${failureText(error)}`,
        );
      if (signal.aborted) fail('Cancelled', 'Worktree creation cancelled; nothing was kept.');
      throw asCreationFailure(error);
    }
  }
  /** Removes only what this creation added: a clean registered worktree and its unchanged branch. */
  private async removeCreated(
    directory: Directory,
    location: string,
    branch: string,
    commit: string,
  ): Promise<string | undefined> {
    try {
      const listed = await directory.git(['worktree', 'list', '--porcelain', '-z']);
      if (parseWorktrees(listed.toString()).some((worktree) => worktree.root === location))
        await directory.git(['worktree', 'remove', '--', location]);
      // Deletes the ref only while it still points at the commit this creation used.
      const ref = 'refs/heads/' + branch;
      await directory.git(['update-ref', '-d', ref, commit]).catch(() => undefined);
      const remaining = await directory
        .git(['rev-parse', '--verify', '--quiet', ref])
        .then((output) => output.toString().trim())
        .catch(() => '');
      if (remaining === commit) return 'branch still exists';
      return exists(location) ? 'location still exists' : undefined;
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
