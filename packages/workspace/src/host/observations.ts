import { Context, Deferred, Effect, Exit, Fiber, Layer, Queue, Scope, Stream } from 'effect';
import {
  CheckoutChangedError,
  InvalidPathError,
  InvalidRequestError,
} from '@moonbase/contracts/workspace-host-errors';
import type { CheckoutTarget, WorkspaceEvent } from '@moonbase/contracts/workspace';
import fs, { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { attempt } from '../attempt.ts';
import { errorText, path, same } from '../validation.ts';
import { Checkouts } from './checkouts.ts';

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

/** Watches checkouts for changes, at most one event every 100 ms per watch. */
export class Observations {
  private readonly subscriptions = new Set<Scope.Closeable>();
  private readonly checkouts: Checkouts['Service'];
  /** Owns every watch; a watcher whose release failed stays here and is released again on close. */
  private readonly scope: Scope.Scope;
  constructor({ checkouts, scope }: { checkouts: Checkouts['Service']; scope: Scope.Scope }) {
    this.checkouts = checkouts;
    this.scope = scope;
  }
  watch(input: { checkout: CheckoutTarget; paths: string[] }) {
    // oxlint-disable-next-line no-this-alias -- The Effect generator retains this observation owner.
    const self = this;
    return Stream.unwrap(
      Effect.gen(function* () {
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
        yield* attempt(() => {
          if (
            !(input.paths.length > 0 && input.paths.length <= 128 && self.subscriptions.size < 64)
          )
            throw new InvalidRequestError({ problem: 'watch-limit' });
          self.subscriptions.add(scope);
        });
        const directory = yield* self.checkouts.directory(input.checkout);
        const common = (yield* attempt(() => self.checkouts.approval(input.checkout))).common?.path;
        // Changed paths since the last event; `undefined` when a watcher could not name one.
        let changedPaths: Set<string> | undefined = new Set();
        const changed = (failure?: string, changedPath?: string) => {
          if (disposed) return;
          error = failure ?? error;
          if (changedPath === undefined) changedPaths = undefined;
          else changedPaths?.add(changedPath);
          Queue.offerUnsafe(changes, true);
        };
        const acquire = (path: string) =>
          Effect.acquireRelease(
            attempt(() => {
              const closed = Deferred.makeUnsafe<void>();
              const watcher = fs
                .watch(path, { persistent: false, recursive: true }, (_kind, name) =>
                  changed(undefined, name ? resolve(path, name) : undefined),
                )
                .on('error', (error) => {
                  changed(errorText(error));
                  // Node stops a failed watcher without guaranteeing a later close event.
                  Deferred.doneUnsafe(closed, Effect.void);
                });
              watcher.once('close', () => Deferred.doneUnsafe(closed, Effect.void));
              return Effect.gen(function* () {
                yield* attempt(() => watcher.close()).pipe(Effect.orDie);
                yield* Deferred.await(closed);
                watcher.removeAllListeners();
              });
            }),
            // A watcher that would not close stays the host's, which tries again when it closes
            // and still reports the failure.
            (release) =>
              release.pipe(
                Effect.onError((cause) =>
                  Scope.addFinalizer(
                    self.scope,
                    Effect.andThen(Effect.exit(release), Effect.failCause(cause)),
                  ),
                ),
              ),
          ).pipe(Scope.provide(scope));
        for (const p of new Set(input.paths)) {
          // Each watcher is a native call: other commands run between them.
          yield* Effect.yieldNow;
          yield* attempt(() => path(p, true));
          const before = yield* directory.entry(p);
          if (!before.directory)
            return yield* new InvalidPathError({ problem: 'watch-not-folder' });
          yield* acquire(resolve(directory.root, p));
          const after = yield* directory.entry(p);
          if (!same(before, after))
            return yield* new CheckoutChangedError({ change: 'watch-directory' });
        }
        if (common && !common.startsWith(directory.root + '/')) yield* acquire(common);
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
                if (!error && paths && common) {
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
                  error = errorText(failure);
                }
                const event: WorkspaceEvent = {
                  checkout: input.checkout,
                  paths: input.paths,
                  ...(error === undefined ? {} : { error }),
                };
                error = undefined;
                return event;
              });
            }),
          ),
        );
        return Stream.concat(
          Stream.succeed<WorkspaceEvent>({ ...input, ready: true }),
          events.pipe(Stream.filter((event) => event !== undefined)),
        );
      }),
    );
  }
}

/** The host's checkout watches. */
export class WorkspaceObservations extends Context.Service<WorkspaceObservations, Observations>()(
  'moonbase/workspace/Observations',
) {
  static readonly layer = Layer.effect(
    WorkspaceObservations,
    Effect.gen(function* () {
      const checkouts = yield* Checkouts;
      return new Observations({ checkouts, scope: yield* Effect.scope });
    }),
  );
}
