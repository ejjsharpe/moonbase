import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { Cause, Context, Data, Effect, Exit, Layer, Scope, Semaphore } from 'effect';
import type { CheckoutTarget, CommandInput, Worktree } from '@moonbase/contracts/workspace';
import {
  BranchTakenError,
  CheckoutChangedError,
  IncompleteCleanupError,
  InvalidBaseError,
  InvalidPathError,
  InvalidRequestError,
  isWorkspaceHostError,
  WorkspaceConflictError,
  WorktreeGitError,
} from '@moonbase/contracts/workspace-host-errors';
import { attempt } from '../attempt.ts';
import { HelperFailure } from '../system-failures.ts';
import { identity, type Directory } from '../filesystem.ts';
import { errorText, requireGit } from '../validation.ts';
import { cancellationPoint } from '../cancellation.ts';
import { Checkouts } from './checkouts.ts';

/** What Git reported, when `error` is the helper's failure. */
const gitFailure = (error: unknown): Partial<HelperFailure> =>
  error instanceof HelperFailure ? error : {};
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

/** Lists a checkout's worktrees and makes new linked ones. */
export class Worktrees {
  private readonly checkouts: Checkouts['Service'];
  /** Where a failure that does not undo a finished creation is reported: the host's close. */
  private readonly reports: Scope.Scope;
  /** Creations run one at a time per project, so none mistakes another's worktree for its own. */
  private readonly creations = new Map<string, Semaphore.Semaphore>();
  constructor({ checkouts, reports }: { checkouts: Checkouts['Service']; reports: Scope.Scope }) {
    this.checkouts = checkouts;
    this.reports = reports;
  }
  /** A plain folder has no worktrees, like a bare repository. */
  listWorktrees(target: CheckoutTarget, open?: Directory) {
    return Effect.gen({ self: this }, function* () {
      const directory = open ?? (yield* this.checkouts.directory(target));
      if (target.vcs === 'none') return { worktrees: [] };
      const output = yield* directory.git(listArgs, undefined, { untranslated: true });
      return { worktrees: parseWorktrees(output.toString()).slice(0, 1000) };
    });
  }
  /**
   * Creates `branch` at `base` in a new linked worktree at `location`, then approves and opens it.
   * One cancelled while it waits for another creation in the project ends at once.
   */
  createWorktree(input: CommandInput<'createWorktree'>) {
    return Effect.gen({ self: this }, function* () {
      const key = input.checkout.projectId;
      let turn = this.creations.get(key);
      if (!turn) this.creations.set(key, (turn = Semaphore.makeUnsafe(1)));
      yield* Effect.interruptible(turn.take(1));
      yield* Effect.addFinalizer(() => turn.release(1));
      return yield* this.createNow(input);
    }).pipe(Effect.scoped);
  }
  private createNow(input: CommandInput<'createWorktree'>) {
    return Effect.gen({ self: this }, function* () {
      yield* cancellationPoint;
      yield* attempt(() => requireGit(input.checkout));
      const directory = yield* this.checkouts.directory(input.checkout);
      const { base, branch } = input;
      if (
        !(
          isAbsolute(input.location) &&
          resolve(input.location) === input.location &&
          basename(input.location) !== ''
        )
      )
        return yield* new InvalidPathError({ problem: 'location-not-absolute' });
      const parent = yield* attempt(() => realpathSync.native(dirname(input.location))).pipe(
        Effect.mapError(() => new InvalidPathError({ problem: 'location-parent-missing' })),
      );
      const parentIdentity = folderIdentity(parent);
      if (!parentIdentity)
        return yield* new InvalidPathError({ problem: 'location-parent-not-folder' });
      // Git precomposes the paths it is given, so the folder it makes is named in NFC.
      const location = join(parent, basename(input.location).normalize('NFC'));
      yield* this.checkouts.permitLocation(location);
      if (yield* attempt(() => exists(location)))
        return yield* new WorkspaceConflictError({ conflict: 'location-exists' });
      // A worktree whose folder is missing (moved, or on an unmounted drive) still owns its location.
      const before = readWorktrees(
        (yield* Effect.interruptible(
          directory.git(listArgs, undefined, { untranslated: true }),
        )).toString(),
      );
      if (before.some((worktree) => sameRoot(worktree.root, location)))
        return yield* new WorkspaceConflictError({ conflict: 'location-registered' });
      const formatted = yield* Effect.interruptible(
        directory.git(['check-ref-format', '--branch', branch]),
      ).pipe(
        Effect.map((output) => output.toString().trim()),
        Effect.orElseSucceed(() => ''),
      );
      if (!(formatted === branch))
        return yield* new InvalidRequestError({ problem: 'branch-name' });
      const ref = 'refs/heads/' + branch;
      const existing = yield* Effect.interruptible(
        directory.git(['show-ref', '--verify', '--quiet', ref]),
      ).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          gitFailure(error).status === 1 && !gitFailure(error).uncertain
            ? Effect.succeed(false)
            : Effect.fail(error),
        ),
      );
      if (existing) return yield* new BranchTakenError({ branch, inside: false });
      const commit = yield* Effect.interruptible(
        directory.git(['rev-parse', '--verify', '--quiet', '--end-of-options', base + '^{commit}']),
      ).pipe(
        Effect.map((output) => output.toString().trim()),
        Effect.orElseSucceed(() => ''),
      );
      if (!/^[a-f0-9]{40,64}$/.test(commit)) return yield* new InvalidBaseError({ base });
      // The empty old value creates the branch only if it does not exist, and the reflog entry and
      // the new worktree's lock reason name this creation, so cleanup removes only what it made.
      const created = { ref, commit, nonce: `moonbase: create worktree ${randomUUID()}` };
      const made = yield* Effect.exit(
        Effect.interruptible(
          directory.git(['update-ref', '--create-reflog', '-m', created.nonce, ref, commit, '']),
        ),
      );
      if (Exit.isFailure(made)) {
        const failure = failureOf(made.cause);
        const cancelled = failure === undefined;
        // Stopped mid-write (cancelled or at the time limit), the branch may be this creation's.
        const cleanup =
          cancelled || gitFailure(failure).uncertain
            ? yield* this.removeBranch(directory, created, false)
            : undefined;
        if (cleanup)
          return yield* new IncompleteCleanupError({
            remains: cleanup,
            inspect: `branch ${branch}`,
          });
        if (cancelled) return yield* Effect.interrupt;
        return yield* Effect.fail(asCreationFailure(failure));
      }
      const added = yield* Effect.exit(
        Effect.gen({ self: this }, function* () {
          // A parent swapped for a link since it was checked would put the worktree elsewhere.
          if (!(folderIdentity(parent) === parentIdentity))
            return yield* new CheckoutChangedError({ change: 'worktree-parent' });
          // Locked from its start until approved, with a reason only this creation knows.
          yield* Effect.interruptible(
            directory.git([
              'worktree',
              'add',
              '--quiet',
              '--lock',
              '--reason',
              created.nonce,
              '--',
              location,
              branch,
            ]),
          );
          // `createWorktree` refuses a plain folder first, so the source names its repository.
          const common = this.checkouts.approval(input.checkout).common!;
          return yield* Effect.interruptible(
            this.checkouts.open(location, { root: location, common }),
          );
        }),
      );
      if (Exit.isFailure(added)) {
        const failure = failureOf(added.cause);
        const cleanup = yield* this.removeCreated(
          directory,
          location,
          parentIdentity!,
          before,
          created,
        );
        if (cleanup)
          return yield* new IncompleteCleanupError({
            remains: cleanup,
            inspect: `${location} and branch ${branch}`,
            failure: failureText(failure),
          });
        if (failure === undefined) return yield* Effect.interrupt;
        return yield* Effect.fail(asCreationFailure(failure));
      }
      // The worktree is approved and kept: a lock left behind is reported but does not undo it.
      const unlock = directory.git(['worktree', 'unlock', '--', location]);
      yield* unlock.pipe(
        Effect.catch(() => unlock),
        Effect.catch((error) =>
          Scope.addFinalizer(
            this.reports,
            Effect.die(new WorktreeLockedError({ location, detail: failureText(error) })),
          ),
        ),
      );
      return added.value;
    });
  }
  /**
   * Removes only what this creation added: the worktree registered at `location` since `before`
   * that still holds this creation's lock, on its branch at its commit, then that branch.
   * Anything else at the location is left for inspection.
   */
  private removeCreated(
    directory: Directory,
    location: string,
    parentIdentity: string,
    before: WorktreeRecord[],
    created: CreatedBranch,
  ): Effect.Effect<string | undefined> {
    return Effect.gen({ self: this }, function* () {
      const listed = yield* directory.git(listArgs, undefined, { untranslated: true });
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
        yield* directory.git(['worktree', 'remove', '--force', '--force', '--', location]);
      }
      // A checkout left at the location may still use the branch, so both are kept.
      if (yield* attempt(() => exists(location))) return 'location still exists';
      return yield* this.removeBranch(directory, created, true);
    }).pipe(Effect.catch((error) => Effect.succeed(failureText(error))));
  }
  /**
   * Deletes the branch this creation made while it is unchanged: still at its commit, with this
   * creation's reflog entry the latest. `made` says the create-only update succeeded; otherwise a
   * branch whose reflog names someone else is theirs and is kept without complaint.
   */
  private removeBranch(
    directory: Directory,
    { ref, commit, nonce }: CreatedBranch,
    made: boolean,
  ): Effect.Effect<string | undefined> {
    const resolveRef = directory
      .git(['rev-parse', '--verify', '--quiet', '--end-of-options', ref])
      .pipe(
        Effect.map((output) => output.toString().trim()),
        Effect.orElseSucceed(() => ''),
      );
    return Effect.gen(function* () {
      // A symbolic ref names another branch, which deleting through it would remove.
      const symbolic = yield* directory.git(['symbolic-ref', '-q', ref]).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (symbolic) return 'the branch was replaced by a symbolic ref';
      const current = yield* resolveRef;
      if (!current) return undefined;
      // A branch that moved is someone's work; one this creation did not make is theirs.
      if (current !== commit) return made ? 'the branch has moved since it was made' : undefined;
      const latest = yield* directory
        .git(['log', '-g', '-n', '1', '--format=%H%x00%gs', '--end-of-options', ref, '--'])
        .pipe(
          Effect.map((output): string | undefined => output.toString().trim()),
          Effect.orElseSucceed(() => undefined),
        );
      if (latest === `${commit}\0${nonce}`) {
        yield* directory
          .git(['update-ref', '--no-deref', '-d', ref, commit])
          .pipe(Effect.orElseSucceed(() => undefined));
        return (yield* resolveRef) === commit ? 'branch still exists' : undefined;
      }
      if (!made && latest) return undefined;
      return 'branch still exists and its reflog does not confirm this creation made it';
    }).pipe(Effect.catch((error) => Effect.succeed(failureText(error))));
  }
}

/** The host's worktrees: listing a project's, and making new linked ones. */
export class WorkspaceWorktrees extends Context.Service<WorkspaceWorktrees, Worktrees>()(
  'moonbase/workspace/Worktrees',
) {
  static readonly layer = Layer.effect(
    WorkspaceWorktrees,
    Effect.gen(function* () {
      const checkouts = yield* Checkouts;
      return new Worktrees({ checkouts, reports: yield* Effect.scope });
    }),
  );
}

/** A worktree made and approved but left locked: reported when the host closes. */
class WorktreeLockedError extends Data.TaggedError('WorktreeLockedError')<{
  readonly location: string;
  readonly detail: string;
}> {
  override get message() {
    return `Worktree ${this.location} was created but is still locked (${this.detail}). Run git worktree unlock on it.`;
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
  return isWorkspaceHostError(error) ? error : new WorktreeGitError({ detail: failureText(error) });
}
/** A failure from `cause`, which may be an interruption: the first failure, or none. */
const failureOf = (cause: Cause.Cause<unknown>) =>
  Cause.hasInterruptsOnly(cause) ? undefined : Cause.squash(cause);
