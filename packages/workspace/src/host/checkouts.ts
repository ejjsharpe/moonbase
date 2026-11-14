import { Context, Effect, Layer, Scope } from 'effect';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import {
  CheckoutAccessError,
  CheckoutChangedError,
  InvalidPathError,
  InvalidRequestError,
} from '@moonbase/contracts/workspace-host-errors';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attempt, type HostFailure } from '../attempt.ts';
import { HelperFailure } from '../system-failures.ts';
import {
  createGitGate,
  Directory,
  identity,
  makeRunner,
  O_NOFOLLOW_ANY,
  type Run,
} from '../filesystem.ts';
import type { Approval } from '../schema.ts';
import { canonical, folded, hash, same } from '../validation.ts';
import { HostSettings } from './host-settings.ts';
import { HostStore } from './host-store.ts';

/** A path's real path, through its nearest existing folder when the path itself doesn't exist. */
function resolveNearest(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(resolveNearest(parent), basename(path));
  }
}
const holdsOrIsInside = (a: string, b: string) => {
  const [x, y] = [folded(a), folded(b)];
  const inside = (outer: string, inner: string) => {
    const p = relative(outer, inner);
    return !p || (p !== '..' && !p.startsWith('../') && !isAbsolute(p));
  };
  return inside(x, y) || inside(y, x);
};
/** The repository a checkout root's Git names: its common directory and which worktree it is. */
type Repository = {
  common: { path: string; identity: string };
  worktree: 'main' | 'linked';
};

/** The branch a checkout has out, or its short commit when it has none. */
export const readBranch = (directory: Directory) =>
  directory.git(['symbolic-ref', '--short', 'HEAD']).pipe(
    Effect.map((output) => output.toString().trim()),
    Effect.catch(() =>
      directory
        .git(['rev-parse', '--short', 'HEAD'])
        .pipe(Effect.map((output) => output.toString().trim() + ' (detached)')),
    ),
  );

/**
 * The checkouts the host approved, and the authority checks every use of one repeats: its
 * identity, its Git metadata, the reserved paths and the owner's root policy. Open checkouts keep
 * a descriptor of their root until the host closes.
 */
export class Checkouts extends Context.Service<
  Checkouts,
  {
    /** Runs the filesystem helper. */
    readonly run: Run;
    /** The Git the host runs. */
    readonly git: string;
    /** The approval of exactly `target`; refuses any other host's or a changed one. */
    approval(target: CheckoutTarget): Approval;
    /** Refuses a path that holds, or sits inside, the host's state or a reserved path. */
    refuseReserved(path: string): void;
    /** The checkout's open directory, re-checked. */
    directory(target: CheckoutTarget): Effect.Effect<Directory, HostFailure>;
    /** Whether `path` is the root of an approved checkout that still holds. */
    hasFolder(path: string): Effect.Effect<boolean, HostFailure>;
    /** Refuses a repository whose ignore policy files are not what Git would read. */
    policy(target: CheckoutTarget): Effect.Effect<void, HostFailure>;
    /** The root policy's answer for `real`; a refusal or a throw denies. */
    permit(real: string, requested: string): Effect.Effect<void, HostFailure>;
    /** A new worktree's location: reserved paths and, as it doesn't exist yet, its parent's policy. */
    permitLocation(location: string): Effect.Effect<void, HostFailure>;
    /** The folder a chat's worktrees go in, and the policy of its parent, where it is made. */
    permitContainer(parent: string): Effect.Effect<void, HostFailure>;
    /** The root's `.git` entry, or null when it has none. */
    gitEntry(root: string): Approval['gitEntry'];
    /**
     * Approves a checkout root: a Git checkout's root, or a plain folder in no repository.
     * `created` names a worktree this host just made at exactly `root`, in the repository whose
     * common directory is `common`.
     */
    open(
      root: string,
      created?: { root: string; common: { path: string; identity: string } },
    ): Effect.Effect<CheckoutTarget, HostFailure>;
  }
>()('moonbase/workspace/Checkouts') {
  static readonly layer = Layer.effect(
    Checkouts,
    Effect.gen(function* () {
      const { config, allowRoot } = yield* HostSettings;
      const store = yield* HostStore;
      const git = config.gitExecutable;
      const gitReady = createGitGate(git);
      const helper =
        config.filesystemHelper ?? fileURLToPath(new URL('../../dist/filesystem', import.meta.url));
      const run = makeRunner(helper);
      // Resolved once: the host's own reserved paths don't move while it runs.
      const reserved = [store.directory, ...(config.reserved ?? [])].map(resolveNearest);
      // Open directories close after everything that may use them has stopped.
      const directoryScope = yield* Scope.fork(yield* Effect.scope);
      const directories = new Map<string, Directory>();
      const makeDirectory = (root: string, expected: string) =>
        new Directory(root, expected, run, git, gitReady);

      const approval = (target: CheckoutTarget) => {
        if (target.hostId !== config.hostId) throw new CheckoutAccessError({ refusal: 'remote' });
        const stored = store.get<Approval>('approvals', target.checkoutId);
        if (!stored || !same(stored.target, target))
          throw new CheckoutAccessError({ refusal: 'not-approved' });
        return stored;
      };
      const refuseReserved = (path: string) => {
        const real = resolveNearest(path);
        for (const each of reserved)
          if (holdsOrIsInside(real, each)) throw new InvalidPathError({ problem: 'reserved' });
      };
      const permit = (real: string, requested: string): Effect.Effect<void, HostFailure> =>
        allowRoot
          ? Effect.tryPromise({
              try: async () => allowRoot(real, requested),
              catch: () => false,
            }).pipe(
              Effect.orElseSucceed(() => false),
              Effect.flatMap((allowed) =>
                allowed
                  ? Effect.void
                  : Effect.fail(new CheckoutAccessError({ refusal: 'outside-policy' })),
              ),
            )
          : Effect.void;
      const gitEntry = (root: string) => {
        let fd: number;
        try {
          fd = openSync(
            join(root, '.git'),
            constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
        try {
          const info = fstatSync(fd);
          if (!(info.isDirectory() || (info.isFile() && info.size < 4096 && info.nlink === 1)))
            throw new CheckoutChangedError({ change: 'git-metadata' });
          return {
            identity: identity(info),
            pointer: info.isFile() ? readFileSync(fd, 'utf8') : null,
          };
        } finally {
          closeSync(fd);
        }
      };
      /** Checks an open directory still is the approved checkout, and its repository unchanged. */
      const verify = (target: CheckoutTarget, directory: Directory, approved: Approval) => {
        directory.check();
        // A plain folder runs no Git, so only its own identity matters.
        if (!approved.common) return;
        if (!same(gitEntry(target.root), approved.gitEntry))
          throw new CheckoutChangedError({ change: 'git-metadata-identity' });
        const fd = openSync(
          approved.common.path,
          constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW_ANY,
        );
        try {
          if (!(identity(fstatSync(fd)) === approved.common.identity))
            throw new CheckoutChangedError({ change: 'common-directory' });
        } finally {
          closeSync(fd);
        }
      };
      /**
       * Every use re-checks reserved paths and the root policy, so a root replaced since it was
       * approved, or one that a smaller policy no longer allows, grants nothing.
       */
      const authorize = (target: CheckoutTarget) =>
        Effect.gen(function* () {
          const approved = yield* attempt(() => approval(target));
          yield* attempt(() => refuseReserved(target.root));
          yield* permit(target.root, target.root);
          return approved;
        });
      const retained = (target: CheckoutTarget, approved: Approval) =>
        Effect.gen(function* () {
          // Found, or checked against the cap, opened and registered in one synchronous step, so
          // two first uses never both open one.
          const { directory, opened } = yield* attempt(() => {
            const open = directories.get(target.checkoutId);
            if (open) return { directory: open, opened: false };
            if (directories.size >= 128)
              throw new InvalidRequestError({ problem: 'checkout-limit' });
            const directory = makeDirectory(target.root, approved.identity);
            directories.set(target.checkoutId, directory);
            return { directory, opened: true };
          });
          if (opened)
            yield* Scope.addFinalizer(
              directoryScope,
              Effect.sync(() => directory.close()),
            );
          return directory;
        }).pipe(Effect.uninterruptible);
      const directory = (target: CheckoutTarget) =>
        Effect.gen(function* () {
          const approved = yield* authorize(target);
          const open = yield* retained(target, approved);
          yield* attempt(() => verify(target, open, approved));
          return open;
        });
      /** Opens `root` for the length of `use` only, so checks never use up the retained cap. */
      const withTransient = <A>(
        root: string,
        expected: string,
        use: (directory: Directory) => Effect.Effect<A, HostFailure>,
      ) =>
        Effect.acquireUseRelease(
          attempt(() => makeDirectory(root, expected)),
          use,
          (open) => Effect.sync(() => open.close()),
        );
      /** Approvals of exactly `root`; a replaced checkout may leave a stale one beside the current. */
      const approvalsAt = (root: string) =>
        store.all<Approval>(
          'approvals',
          "bucket='approvals' AND json_extract(body, '$.target.root')=?",
          [root],
        );
      const hasFolder = (path: string) =>
        Effect.gen(function* () {
          for (const each of yield* attempt(() => approvalsAt(path))) {
            const held = yield* Effect.exit(
              Effect.gen(function* () {
                const approved = yield* authorize(each.target);
                const open = directories.get(each.target.checkoutId);
                if (open) return yield* attempt(() => verify(each.target, open, approved));
                return yield* withTransient(each.target.root, approved.identity, (transient) =>
                  attempt(() => verify(each.target, transient, approved)),
                );
              }),
            );
            // A stale approval; another of the same root may still hold.
            if (held._tag === 'Success') return true;
          }
          return false;
        });
      const policy = (target: CheckoutTarget) =>
        attempt(() => {
          const common = approval(target).common;
          if (!common) return;
          for (const p of ['info', 'info/exclude']) {
            let fd: number;
            try {
              fd = openSync(
                join(common.path, p),
                constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY,
              );
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
              throw error;
            }
            try {
              const info = fstatSync(fd);
              if (!(p === 'info' ? info.isDirectory() : info.isFile()))
                throw new CheckoutChangedError({ change: 'ignore-policy' });
            } finally {
              closeSync(fd);
            }
          }
        });
      /** The repository whose working tree `directory` is the top of. */
      const inspectRepository = (directory: Directory) =>
        Effect.gen(function* () {
          const root = directory.root;
          const top = (yield* directory.git(['rev-parse', '--show-toplevel'])).toString().trim();
          if (!(realpathSync(top) === root))
            return yield* new InvalidPathError({ problem: 'not-checkout-root' });
          const output = yield* directory.git(['rev-parse', '--git-dir', '--git-common-dir']);
          return yield* attempt((): Repository => {
            const [gitDirectory, common] = output
              .toString()
              .trim()
              .split('\n')
              .map((p) => realpathSync(resolve(root, p)));
            const fd = openSync(
              common,
              constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW_ANY,
            );
            try {
              return {
                common: { path: common, identity: identity(fstatSync(fd)) },
                worktree: gitDirectory === common ? 'main' : 'linked',
              };
            } finally {
              closeSync(fd);
            }
          });
        });
      const open = (
        requested: string,
        created?: { root: string; common: { path: string; identity: string } },
      ) =>
        Effect.gen(function* () {
          if (
            !(typeof requested === 'string' && isAbsolute(requested) && !requested.includes('\0'))
          )
            return yield* new InvalidPathError({ problem: 'root-not-absolute' });
          const root = yield* attempt(() => realpathSync(requested));
          if (created)
            if (!(root === created.root))
              return yield* new CheckoutChangedError({ change: 'worktree-location' });
          yield* attempt(() => refuseReserved(root));
          yield* permit(root, requested);
          const id = yield* attempt(() => {
            const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW_ANY);
            try {
              return identity(fstatSync(fd));
            } finally {
              closeSync(fd);
            }
          });
          const entry = yield* attempt(() => gitEntry(root));
          return yield* withTransient(root, id, (directory) =>
            Effect.gen(function* () {
              const repository = entry || created ? yield* inspectRepository(directory) : null;
              if (created)
                if (
                  !(
                    repository?.common.path === created.common.path &&
                    repository.common.identity === created.common.identity
                  )
                )
                  return yield* new CheckoutChangedError({ change: 'worktree-repository' });
              if (!repository) {
                // No `.git` here: a folder inside a repository is not its checkout root.
                // Untranslated, so the refusal below reads the same in every locale.
                const inside = yield* directory
                  .git(['rev-parse', '--git-dir'], undefined, { untranslated: true })
                  .pipe(
                    Effect.as(true),
                    Effect.catch((error) =>
                      error instanceof HelperFailure &&
                      error.status === 128 &&
                      /not a git repository/i.test(error.stderr)
                        ? Effect.succeed(false)
                        : Effect.fail(error),
                    ),
                  );
                if (inside) return yield* new InvalidPathError({ problem: 'not-checkout-root' });
              }
              const projectId = hash(
                canonical(
                  repository
                    ? [config.hostId, repository.common.path, repository.common.identity]
                    : [config.hostId, id],
                ),
              );
              const previous = yield* attempt(() => approvalsAt(root));
              const current = previous.find(
                (a) => a.identity === id && a.target.projectId === projectId,
              );
              if (current) return current.target;
              // A plain folder that has since become a repository of its own (its main working
              // tree, with its own `.git` folder) is approved again as Git; a `.git` pointing
              // elsewhere is not.
              const initialized =
                repository?.worktree === 'main' &&
                repository.common.path === join(root, '.git') &&
                previous.some((a) => a.identity === id && a.target.vcs === 'none');
              // A worktree this host just made at a removed one's location is approved afresh;
              // the stale approval stays but matches nothing. Anywhere else a replaced directory
              // is refused.
              if (!(!previous.length || created !== undefined || initialized))
                return yield* new CheckoutChangedError({ change: 'identity' });
              const base = {
                hostId: config.hostId,
                checkoutId: hash(canonical([config.hostId, root, id])),
                projectId,
                root,
              };
              const target: CheckoutTarget = repository
                ? {
                    vcs: 'git',
                    ...base,
                    branch: yield* readBranch(directory),
                    worktree: repository.worktree,
                  }
                : { vcs: 'none', ...base };
              yield* attempt(() =>
                store.put('approvals', target.checkoutId, {
                  target,
                  identity: id,
                  common: repository?.common ?? null,
                  gitEntry: entry,
                }),
              );
              return target;
            }),
          );
        });
      return {
        run,
        git,
        approval,
        refuseReserved,
        directory,
        hasFolder,
        policy,
        permit,
        permitLocation: (location) =>
          Effect.gen(function* () {
            yield* attempt(() => refuseReserved(location));
            if (allowRoot) yield* permit(dirname(location), dirname(location));
          }),
        permitContainer: (parent) =>
          Effect.gen(function* () {
            yield* attempt(() => refuseReserved(parent));
            if (allowRoot) yield* permit(dirname(parent), dirname(parent));
          }),
        gitEntry,
        open,
      };
    }),
  );
}
