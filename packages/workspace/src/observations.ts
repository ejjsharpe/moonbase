import { normalizeApplicationError, releaseResource } from '@moonbase/effect';
import type { ApplicationError, CheckoutTarget } from '@moonbase/contracts/workspace';
import {
  decodeWorkspaceEvent,
  decodeWorkspaceWatchInput,
} from '@moonbase/contracts/workspace-schema';
import { Cause, Deferred, Effect, Exit, Fiber, Queue, Scope, Stream } from 'effect';
import { readdirSync, readFileSync, realpathSync, watch as fsWatch } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Directory } from './filesystem.ts';
import { ensure, path, same } from './validation.ts';

const isInside = (path: string, parent: string) => {
  const rel = relative(parent, path);
  return rel !== '' && !rel.startsWith('..' + sep) && rel !== '..';
};

/** Every linked worktree of the repository, by its private Git folder name and its root. */
function readWorktrees(common: string) {
  let names: string[];
  try {
    names = readdirSync(join(common, 'worktrees'));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    try {
      const marker = readFileSync(join(common, 'worktrees', name, 'gitdir'), 'utf8').trim();
      const root = dirname(resolve(common, 'worktrees', name, marker));
      let real = root;
      try {
        real = realpathSync(root);
      } catch {
        /* A removed worktree keeps its private folder until Git prunes it. */
      }
      return [{ name, root: real }];
    } catch {
      return [];
    }
  });
}

/**
 * Whether a changed path belongs to another worktree of the same repository, so it can change
 * neither this checkout's files nor its Git status: files under a worktree nested in this root
 * (agent worktrees often live in an ignored folder of the main checkout), another worktree's
 * private Git folder or index, the shared object store, or a Git lock file. Shared refs still
 * count, and so does a worktree being added or removed.
 */
function isOtherWorktreeChange(
  path: string,
  root: string,
  common: string,
  worktrees: { name: string; root: string }[],
) {
  if (path === common || isInside(path, common)) {
    const parts = relative(common, path).split(sep);
    // New objects matter only once a ref or an index names them, and those changes still count.
    if (parts[0] === 'objects' || parts.at(-1)?.endsWith('.lock')) return true;
    const own = worktrees.find((worktree) => worktree.root === root)?.name;
    // The common folder's own index belongs to the main worktree.
    if (own !== undefined && parts.length === 1 && parts[0] === 'index') return true;
    if (parts[0] !== 'worktrees' || parts.length < 3) return false;
    return parts[1] !== own;
  }
  return worktrees.some(
    (worktree) =>
      worktree.root !== root &&
      isInside(worktree.root, root) &&
      (path === worktree.root || isInside(path, worktree.root)),
  );
}

export class WorkspaceObservations {
  private readonly subscriptions = new Set<Scope.Closeable>();
  private readonly watcherReleases = new Set<Effect.Effect<void>>();
  private readonly directory: (target: CheckoutTarget) => Promise<Directory>;
  private readonly getCommonGitPath: (target: CheckoutTarget) => string;
  private readonly scope: Scope.Closeable;
  private readonly runCommand: <A>(fn: () => Promise<A>) => Effect.Effect<A, ApplicationError>;
  private readonly isClosed: () => boolean;
  private readonly reportCleanup: (cause: Cause.Cause<never>) => void;
  constructor(
    directory: (target: CheckoutTarget) => Promise<Directory>,
    getCommonGitPath: (target: CheckoutTarget) => string,
    scope: Scope.Closeable,
    runCommand: <A>(fn: () => Promise<A>) => Effect.Effect<A, ApplicationError>,
    isClosed: () => boolean,
    reportCleanup: (cause: Cause.Cause<never>) => void,
  ) {
    this.directory = directory;
    this.getCommonGitPath = getCommonGitPath;
    this.scope = scope;
    this.runCommand = runCommand;
    this.isClosed = isClosed;
    this.reportCleanup = reportCleanup;
  }
  close(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const outcomes = yield* Effect.forEach(
        [
          Scope.close(this.scope, Exit.void),
          Effect.suspend(() =>
            Effect.forEach([...this.watcherReleases], Effect.exit).pipe(
              Effect.flatMap((outcomes) => {
                const failures = outcomes.flatMap((exit) =>
                  Exit.isFailure(exit) ? [exit.cause] : [],
                );
                return failures.length
                  ? Effect.failCause(failures.reduce((all, cause) => Cause.combine(all, cause)))
                  : Effect.void;
              }),
            ),
          ),
        ],
        Effect.exit,
      );
      const failures = outcomes.flatMap((exit) => (Exit.isFailure(exit) ? [exit.cause] : []));
      if (failures.length)
        return yield* Effect.failCause(failures.reduce((all, cause) => Cause.combine(all, cause)));
    });
  }
  watch(input: { checkout: CheckoutTarget; paths: string[] }) {
    // oxlint-disable-next-line no-this-alias -- The Effect generator retains this observation owner.
    const self = this;
    return Stream.unwrap(
      Effect.gen(function* () {
        const captured = yield* Effect.try({
          try: () => decodeWorkspaceWatchInput(input),
          catch: normalizeApplicationError,
        });
        const scope = yield* Effect.acquireRelease(Scope.fork(self.scope, 'parallel'), (scope) =>
          Scope.close(scope, Exit.void),
        );
        const changes = yield* Queue.sliding<boolean>(1);
        let disposed = false,
          error: string | undefined;
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            disposed = true;
            self.subscriptions.delete(scope);
            Queue.shutdownUnsafe(changes);
          }),
        );
        yield* Effect.try({
          try: () => {
            ensure(
              !self.isClosed() &&
                captured.paths.length > 0 &&
                captured.paths.length <= 128 &&
                self.subscriptions.size < 64,
              'Watch subscription limit reached.',
            );
            self.subscriptions.add(scope);
          },
          catch: normalizeApplicationError,
        });
        const directory = yield* self.runCommand(() => self.directory(captured.checkout));
        const common = self.getCommonGitPath(captured.checkout);
        // Changed paths since the last event; `undefined` when a watcher could not name one.
        let changedPaths: Set<string> | undefined = new Set();
        const changed = (failure?: string, changedPath?: string) => {
          if (disposed || self.isClosed()) return;
          error = failure ?? error;
          if (changedPath === undefined) changedPaths = undefined;
          else changedPaths?.add(changedPath);
          Queue.offerUnsafe(changes, true);
        };
        const acquire = (path: string) =>
          Effect.acquireRelease(
            Effect.try({
              try: () => {
                const closed = Deferred.makeUnsafe<void>();
                const watcher = fsWatch(
                  path,
                  { persistent: false, recursive: true },
                  (_kind, name) => changed(undefined, name ? resolve(path, name) : undefined),
                ).on('error', (error) => {
                  changed(normalizeApplicationError(error).message);
                  // Node stops a failed watcher without guaranteeing a later close event.
                  Deferred.doneUnsafe(closed, Effect.void);
                });
                watcher.once('close', () => Deferred.doneUnsafe(closed, Effect.void));
                const release = Effect.gen(function* () {
                  yield* releaseResource(() => watcher.close());
                  yield* Deferred.await(closed);
                  yield* Effect.sync(() => {
                    watcher.removeAllListeners();
                    self.watcherReleases.delete(release);
                  });
                });
                self.watcherReleases.add(release);
                return release;
              },
              catch: normalizeApplicationError,
            }),
            (release) =>
              release.pipe(
                Effect.onExit((exit) =>
                  Effect.sync(() => {
                    if (Exit.isFailure(exit)) self.reportCleanup(exit.cause);
                  }),
                ),
              ),
          ).pipe(Scope.provide(scope));
        for (const p of new Set(captured.paths)) {
          yield* Effect.try({ try: () => path(p, true), catch: normalizeApplicationError });
          const before = yield* self.runCommand(() => directory.entry(p));
          yield* Effect.try({
            try: () =>
              ensure(
                before.directory,
                'Watch directory paths, including parent directories of files.',
              ),
            catch: normalizeApplicationError,
          });
          yield* acquire(resolve(directory.root, p));
          const after = yield* self.runCommand(() => directory.entry(p));
          yield* Effect.try({
            try: () => ensure(same(before, after), 'Watch directory changed during subscription.'),
            catch: normalizeApplicationError,
          });
        }
        if (!common.startsWith(directory.root + '/')) yield* acquire(common);
        const events = Stream.fromQueue(changes).pipe(
          Stream.mapEffect(() =>
            Effect.gen(function* () {
              const timer = yield* Effect.forkIn(Effect.sleep('100 millis'), scope);
              yield* Fiber.join(timer);
              yield* Queue.clear(changes);
              return yield* Effect.sync(() => {
                const paths = changedPaths;
                changedPaths = new Set();
                // Agents in other worktrees run Git and write files constantly; only changes
                // that can affect this checkout reach its clients.
                if (!error && paths) {
                  const worktrees = readWorktrees(common);
                  if (
                    [...paths].every((changedPath) =>
                      isOtherWorktreeChange(changedPath, directory.root, common, worktrees),
                    )
                  )
                    return undefined;
                }
                try {
                  directory.check();
                } catch (failure) {
                  error = normalizeApplicationError(failure).message;
                }
                const event = decodeWorkspaceEvent({ ...captured, error });
                error = undefined;
                return event;
              });
            }),
          ),
        );
        return Stream.concat(
          Stream.succeed(decodeWorkspaceEvent({ ...captured, ready: true })),
          events.pipe(Stream.filter((event) => event !== undefined)),
        );
      }),
    );
  }
}
