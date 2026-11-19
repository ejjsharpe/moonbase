import { Context, Effect, Layer, Scope } from 'effect';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { ProcessGroups } from '@moonbase/process-group';
import {
  CheckoutAccessError,
  CheckoutChangedError,
  InvalidPathError,
  InvalidRequestError,
} from '@moonbase/contracts/workspace-host-errors';
import { constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attempt, type WorkspaceFailure } from '../attempt.ts';
import type { StoreFailure } from '../store.ts';
import { systemCall, type SystemFailure } from '../system-failures.ts';
import {
  Directory,
  identity,
  O_NOFOLLOW_ANY,
  statDescriptor,
  withDescriptor,
} from '../filesystem.ts';
import { makeFilesystemHelper } from '../filesystem-helper.ts';
import { makeGitGate } from '../git-gate.ts';
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
const folderFlags = constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW_ANY;
const entryFlags = constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY;
/** The identity of the folder at `path`, opened without following links. */
const folderIdentity = (path: string) =>
  systemCall(() => identity(statDescriptor(path, folderFlags)));
/** `effect`'s value, or undefined when what it opens does not exist. */
const unlessMissing = <A>(effect: Effect.Effect<A, SystemFailure>) =>
  effect.pipe(
    Effect.catchTag('SystemFailure', (failure) =>
      failure.code === 'ENOENT' ? Effect.succeed(undefined) : Effect.fail(failure),
    ),
  );
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
    /** The Git the host runs. */
    readonly git: string;
    /** The approval of exactly `target`; refuses any other host's or a changed one. */
    approval(target: CheckoutTarget): Effect.Effect<Approval, CheckoutAccessError | StoreFailure>;
    /** Whether a path holds, or sits inside, the host's state or a reserved path. */
    isReserved(path: string): boolean;
    /** Refuses a path that holds, or sits inside, the host's state or a reserved path. */
    refuseReserved(path: string): Effect.Effect<void, InvalidPathError>;
    /** The checkout's open directory, re-checked. */
    directory(target: CheckoutTarget): Effect.Effect<Directory, WorkspaceFailure>;
    /** Whether `path` is the root of an approved checkout that still holds. */
    hasFolder(path: string): Effect.Effect<boolean, WorkspaceFailure>;
    /** Refuses a repository whose ignore policy files are not what Git would read. */
    policy(target: CheckoutTarget): Effect.Effect<void, WorkspaceFailure>;
    /** The root policy's answer for `real`; a refusal or a throw denies. */
    permit(real: string, requested: string): Effect.Effect<void, WorkspaceFailure>;
    /**
     * A folder the host is about to make (a new worktree's location, or the folder a chat's
     * worktrees go in): reserved paths and, as it doesn't exist yet, its parent's policy.
     */
    permitNewFolder(path: string): Effect.Effect<void, WorkspaceFailure>;
    /** The root's `.git` entry, or null when it has none. */
    gitEntry(
      root: string,
    ): Effect.Effect<Approval['gitEntry'], CheckoutChangedError | SystemFailure>;
    /**
     * Approves a checkout root: a Git checkout's root, or a plain folder in no repository.
     * `created` names a worktree this host just made at exactly `root`, in the repository whose
     * common directory is `common`.
     */
    open(
      root: string,
      created?: { root: string; common: { path: string; identity: string } },
    ): Effect.Effect<CheckoutTarget, WorkspaceFailure>;
  }
>()('moonbase/workspace/Checkouts') {
  static readonly layer = Layer.effect(
    Checkouts,
    Effect.gen(function* () {
      const { config, allowRoot } = yield* HostSettings;
      const store = yield* HostStore;
      const git = config.gitExecutable;
      const gitReady = yield* makeGitGate(git);
      const helper =
        config.filesystemHelper ?? fileURLToPath(new URL('../../dist/filesystem', import.meta.url));
      const filesystemHelper = makeFilesystemHelper(helper, yield* ProcessGroups);
      // Resolved once: the host's own reserved paths don't move while it runs.
      const reserved = [store.directory, ...(config.reserved ?? [])].map(resolveNearest);
      // Open directories close after everything that may use them has stopped.
      const directoryScope = yield* Scope.fork(yield* Effect.scope);
      const directories = new Map<string, Directory>();
      const makeDirectory = (root: string, expected: string) =>
        new Directory(root, expected, filesystemHelper, git, gitReady);

      const approval = (target: CheckoutTarget) =>
        target.hostId !== config.hostId
          ? Effect.fail(new CheckoutAccessError({ refusal: 'remote' }))
          : store
              .step(() => store.get<Approval>('approvals', target.checkoutId))
              .pipe(
                Effect.flatMap((stored) =>
                  stored && same(stored.target, target)
                    ? Effect.succeed(stored)
                    : Effect.fail(new CheckoutAccessError({ refusal: 'not-approved' })),
                ),
              );
      const isReserved = (path: string) => {
        const real = resolveNearest(path);
        return reserved.some((each) => holdsOrIsInside(real, each));
      };
      const refuseReserved = (path: string) =>
        Effect.suspend(() =>
          isReserved(path)
            ? Effect.fail(new InvalidPathError({ problem: 'reserved' }))
            : Effect.void,
        );
      const permit = (real: string, requested: string): Effect.Effect<void, WorkspaceFailure> =>
        allowRoot
          ? Effect.suspend(() => allowRoot(real, requested)).pipe(
              Effect.catchDefect(() => Effect.succeed(false)),
              Effect.orElseSucceed(() => false),
              Effect.flatMap((allowed) =>
                allowed
                  ? Effect.void
                  : Effect.fail(new CheckoutAccessError({ refusal: 'outside-policy' })),
              ),
            )
          : Effect.void;
      const gitEntry = (root: string) =>
        unlessMissing(
          systemCall(() =>
            // Read through the descriptor its type was checked on, in one step.
            withDescriptor(openSync(join(root, '.git'), entryFlags), (fd) => {
              const info = fstatSync(fd);
              if (!(info.isDirectory() || (info.isFile() && info.size < 4096 && info.nlink === 1)))
                return 'invalid' as const;
              return {
                identity: identity(info),
                pointer: info.isFile() ? readFileSync(fd, 'utf8') : null,
              };
            }),
          ),
        ).pipe(
          Effect.flatMap((entry) =>
            entry === 'invalid'
              ? Effect.fail(new CheckoutChangedError({ change: 'git-metadata' }))
              : Effect.succeed(entry ?? null),
          ),
        );
      /** Checks an open directory still is the approved checkout, and its repository unchanged. */
      const verify = (target: CheckoutTarget, directory: Directory, approved: Approval) =>
        Effect.gen(function* () {
          yield* directory.check();
          // A plain folder runs no Git, so only its own identity matters.
          if (!approved.common) return;
          if (!same(yield* gitEntry(target.root), approved.gitEntry))
            return yield* new CheckoutChangedError({ change: 'git-metadata-identity' });
          if (!((yield* folderIdentity(approved.common.path)) === approved.common.identity))
            return yield* new CheckoutChangedError({ change: 'common-directory' });
        });
      /**
       * Every use re-checks reserved paths and the root policy, so a root replaced since it was
       * approved, or one that a smaller policy no longer allows, grants nothing.
       */
      const authorize = (target: CheckoutTarget) =>
        Effect.gen(function* () {
          const approved = yield* approval(target);
          yield* refuseReserved(target.root);
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
          yield* verify(target, open, approved);
          return open;
        });
      /** Opens `root` for the length of `use` only, so checks never use up the retained cap. */
      const withTransient = <A>(
        root: string,
        expected: string,
        use: (directory: Directory) => Effect.Effect<A, WorkspaceFailure>,
      ) =>
        Effect.acquireUseRelease(
          attempt(() => makeDirectory(root, expected)),
          use,
          (open) => Effect.sync(() => open.close()),
        );
      /** Approvals of exactly `root`; a replaced checkout may leave a stale one beside the current. */
      const approvalsAt = (root: string) =>
        store.step(() =>
          store.all<Approval>(
            'approvals',
            "bucket='approvals' AND json_extract(body, '$.target.root')=?",
            [root],
          ),
        );
      const hasFolder = (path: string) =>
        Effect.gen(function* () {
          for (const each of yield* approvalsAt(path)) {
            const held = yield* Effect.exit(
              Effect.gen(function* () {
                const approved = yield* authorize(each.target);
                const open = directories.get(each.target.checkoutId);
                if (open) return yield* verify(each.target, open, approved);
                return yield* withTransient(each.target.root, approved.identity, (transient) =>
                  verify(each.target, transient, approved),
                );
              }),
            );
            // A stale approval; another of the same root may still hold.
            if (held._tag === 'Success') return true;
          }
          return false;
        });
      const policy = (target: CheckoutTarget) =>
        Effect.gen(function* () {
          const common = (yield* approval(target)).common;
          if (!common) return;
          for (const p of ['info', 'info/exclude']) {
            const info = yield* unlessMissing(
              systemCall(() => statDescriptor(join(common.path, p), entryFlags)),
            );
            if (info && !(p === 'info' ? info.isDirectory() : info.isFile()))
              return yield* new CheckoutChangedError({ change: 'ignore-policy' });
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
          const [gitDirectory, common] = yield* systemCall(() =>
            output
              .toString()
              .trim()
              .split('\n')
              .map((p) => realpathSync(resolve(root, p))),
          );
          return {
            common: { path: common, identity: yield* folderIdentity(common) },
            worktree: gitDirectory === common ? 'main' : 'linked',
          } satisfies Repository;
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
          const root = yield* systemCall(() => realpathSync(requested));
          if (created)
            if (!(root === created.root))
              return yield* new CheckoutChangedError({ change: 'worktree-location' });
          yield* refuseReserved(root);
          yield* permit(root, requested);
          const id = yield* folderIdentity(root);
          const entry = yield* gitEntry(root);
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
                    Effect.catchTag('HelperFailure', (failure) =>
                      failure.status === 128 && /not a git repository/i.test(failure.stderr)
                        ? Effect.succeed(false)
                        : Effect.fail(failure),
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
              const previous = yield* approvalsAt(root);
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
              yield* store.step(() =>
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
        git,
        approval,
        isReserved,
        refuseReserved,
        directory,
        hasFolder,
        policy,
        permit,
        permitNewFolder: (path) =>
          Effect.gen(function* () {
            yield* refuseReserved(path);
            if (allowRoot) yield* permit(dirname(path), dirname(path));
          }),
        gitEntry,
        open,
      };
    }),
  );
}
