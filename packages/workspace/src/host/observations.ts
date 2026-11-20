import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Queue,
  Ref,
  Schedule,
  Scope,
  Sink,
  Stream,
} from 'effect';
import {
  CheckoutChangedError,
  InvalidPathError,
  InvalidRequestError,
} from '@moonbase/contracts/workspace-host-errors';
import type { CheckoutTarget, WorkspaceEvent } from '@moonbase/contracts/workspace';
import fs, { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { WorkspaceFailure } from '../attempt.ts';
import { systemCall } from '../system-failures.ts';
import { errorText, requirePath, same } from '../validation.ts';
import { Checkouts } from './checkouts.ts';

/** A watch reports at most one event this often. */
const observationInterval = Duration.millis(100);
/** The most watches the host keeps open at once, and the most folders one may name. */
const maximumWatches = 64,
  maximumPaths = 128;

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

/** What one native watcher reported: a changed path (unnamed when it could not say), or a failure. */
type Change = { readonly path: string | undefined } | { readonly error: string };

/** The changes of one 100 ms window. `paths` is undefined once a change could not name its path. */
type Batch = { readonly paths: Set<string> | undefined; readonly error: string | undefined };

/** Folds a change into its window; the latest failure wins. */
const addChange = (batch: Batch, change: Change): Batch => {
  if ('error' in change) return { paths: undefined, error: change.error };
  if (change.path === undefined) return { ...batch, paths: undefined };
  batch.paths?.add(change.path);
  return batch;
};

/** The host's checkout watches, at most one event every 100 ms per watch. */
export class WorkspaceObservations extends Context.Service<
  WorkspaceObservations,
  {
    /** A `ready` event once every watcher is open, then one event per window with changes. */
    watch(input: {
      checkout: CheckoutTarget;
      paths: string[];
    }): Stream.Stream<WorkspaceEvent, WorkspaceFailure>;
  }
>()('moonbase/workspace/Observations') {
  static readonly layer = Layer.effect(
    WorkspaceObservations,
    Effect.gen(function* () {
      const checkouts = yield* Checkouts;
      // Owns every watch; a watcher whose release failed stays here and is released again on close.
      const hostScope = yield* Effect.scope;
      const subscriptions = yield* Ref.make(0);
      /** Counts a watch for its lifetime; checked and counted in one step, so none pass the cap together. */
      const admit = Effect.acquireRelease(
        Effect.flatMap(
          Ref.modify(subscriptions, (count) =>
            count < maximumWatches ? [true, count + 1] : [false, count],
          ),
          (admitted) =>
            admitted
              ? Effect.void
              : Effect.fail(new InvalidRequestError({ problem: 'watch-limit' })),
        ),
        () => Ref.update(subscriptions, (count) => count - 1),
      );
      /** Opens a recursive native watcher on `path` for the rest of `scope`, reporting into `changes`. */
      const openWatcher = (path: string, changes: Queue.Queue<Change>, scope: Scope.Scope) =>
        Effect.acquireRelease(
          systemCall(() => {
            const closed = Deferred.makeUnsafe<void>();
            const watcher = fs
              .watch(path, { persistent: false, recursive: true }, (_kind, name) =>
                Queue.offerUnsafe(changes, { path: name ? resolve(path, name) : undefined }),
              )
              .on('error', (error) => {
                Queue.offerUnsafe(changes, { error: errorText(error) });
                // Node stops a failed watcher without guaranteeing a later close event.
                Deferred.doneUnsafe(closed, Effect.void);
              });
            watcher.once('close', () => Deferred.doneUnsafe(closed, Effect.void));
            return Effect.gen(function* () {
              yield* systemCall(() => watcher.close()).pipe(Effect.orDie);
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
                  hostScope,
                  Effect.andThen(Effect.exit(release), Effect.failCause(cause)),
                ),
              ),
            ),
        ).pipe(Scope.provide(scope));
      return {
        watch: (input) =>
          Stream.unwrap(
            Effect.gen(function* () {
              if (!(input.paths.length > 0 && input.paths.length <= maximumPaths))
                return yield* new InvalidRequestError({ problem: 'watch-limit' });
              yield* admit;
              // The watch's watchers close with it, or with the host if it closes first.
              const scope = yield* Effect.acquireRelease(
                Scope.fork(hostScope, 'parallel'),
                (scope) => Scope.close(scope, Exit.void),
              );
              // Shut down with the watchers, so a host closing first also ends the stream.
              const changes = yield* Queue.unbounded<Change>();
              yield* Scope.addFinalizer(scope, Queue.shutdown(changes));
              const directory = yield* checkouts.directory(input.checkout);
              const common = (yield* checkouts.approval(input.checkout)).common?.path;
              for (const p of new Set(input.paths)) {
                // Each watcher is a native call: other commands run between them.
                yield* Effect.yieldNow;
                yield* requirePath(p, true);
                const before = yield* directory.entry(p);
                if (!before.directory)
                  return yield* new InvalidPathError({ problem: 'watch-not-folder' });
                yield* openWatcher(resolve(directory.root, p), changes, scope);
                const after = yield* directory.entry(p);
                if (!same(before, after))
                  return yield* new CheckoutChangedError({ change: 'watch-directory' });
              }
              if (common && !common.startsWith(directory.root + '/'))
                yield* openWatcher(common, changes, scope);
              /** The event for one window, or undefined when nothing in it can affect this checkout. */
              const publish = Effect.fnUntraced(function* ({ paths, error }: Batch) {
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
                const checked = yield* Effect.exit(directory.check());
                const failure = Exit.isFailure(checked)
                  ? errorText(Cause.squash(checked.cause))
                  : error;
                const event: WorkspaceEvent = {
                  checkout: input.checkout,
                  paths: input.paths,
                  ...(failure === undefined ? {} : { error: failure }),
                };
                return event;
              });
              // A window opens with its first change (a checkout writes many files) and gathers
              // the rest for 100 ms; changes meanwhile wait for the next one.
              const events = Stream.fromQueue(changes).pipe(
                Stream.aggregateWithin(
                  Sink.reduce((): Batch => ({ paths: new Set(), error: undefined }), addChange),
                  Schedule.spaced(observationInterval),
                ),
                Stream.mapEffect(publish),
                Stream.filter((event) => event !== undefined),
              );
              return Stream.concat(
                Stream.succeed<WorkspaceEvent>({ ...input, ready: true }),
                events,
              );
            }),
          ),
      };
    }),
  );
}
