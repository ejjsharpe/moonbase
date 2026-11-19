import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  PubSub,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import { WorkspaceService } from '@moonbase/contracts/workspace-service';
import type { WorkspaceError } from '@moonbase/contracts/workspace-errors';
import type {
  CheckoutTarget,
  DirectoryListing,
  WorkspaceEvent,
} from '@moonbase/contracts/workspace';
import { retryWatch, watchRetry } from '../../watch-retry.ts';
import { EditorError, isUnavailable, type EditorFailure } from '../editor-errors.ts';
import { isRelativePath } from '../relative-path.ts';
import { checkoutKey, sameCheckout } from '../recovery/recovery-references.ts';
import { EditorSession } from '../session/session-service.ts';
import { EditorAlerts } from '../alerts/alerts-service.ts';
import { EditorViews } from '../views/views-service.ts';
import {
  classify,
  classifyShown,
  emptyDiscovery,
  keepClassification,
  listingKey,
  type DiscoveryState,
} from './discovery.ts';

/** What a refresh of a checkout reads, given by the tabs that show it. */
export type RefreshSteps = {
  /** Whether the checkout is still open. */
  readonly isCurrent: Effect.Effect<boolean>;
  readonly refreshListings: Effect.Effect<void>;
  /** Reads the active file's comparison again, if one is shown. */
  readonly refreshComparison: Effect.Effect<void>;
};

/** One listing read of a folder, which later callers join until a change makes it stale. */
type ListingRead = {
  scope: Scope.Scope;
  /** Where its Git classification runs; a newer read closes it, or keeps one running. */
  classificationScope: Scope.Closeable;
  listed: boolean;
  classifying: boolean;
  /** A change was seen since it started: callers start a new read. */
  stale: boolean;
  /** Whether it reports its failures; a quiet one leaves that to later callers. */
  report: boolean;
  done: Deferred.Deferred<DirectoryListing, EditorFailure>;
  /** The read that replaced it, which is newer. */
  successor?: ListingRead;
  /** The read whose classification was shown when this one's listing was. */
  shownClassification?: ListingRead;
};

export type EditorDiscoveryShape = {
  readonly state: SubscriptionRef.SubscriptionRef<DiscoveryState>;
  readonly get: Effect.Effect<DiscoveryState>;
  readonly update: (f: (state: DiscoveryState) => DiscoveryState) => Effect.Effect<void>;
  /** Each checkout a watch reported a change in, for queries to refresh. */
  readonly changes: Stream.Stream<CheckoutTarget>;
  /**
   * Watches a checkout, replacing any watch of it. A retryable (`Unavailable`) failure, such as a
   * daemon that restarted, watches again after each backoff and counts the new watch's first ready
   * as a change, since changes were missed meanwhile; only a failure that cannot be retried, or the
   * last of them, is reported and leaves the watch lost, which a refresh or reopen arms again.
   */
  readonly observe: (
    checkout: CheckoutTarget,
    options: {
      readonly isOpen: Effect.Effect<boolean>;
      /** A change: `isCurrent` says whether this watch still holds the checkout. */
      readonly onChanged: (isCurrent: Effect.Effect<boolean>) => Effect.Effect<void>;
    },
  ) => Effect.Effect<void>;
  /** Ends a checkout's watch and the reads in it. */
  readonly release: (checkout: CheckoutTarget) => Effect.Effect<void>;
  readonly isWatchLost: (checkout: CheckoutTarget) => Effect.Effect<boolean>;
  /**
   * Lists a folder of an open checkout and shows it, then classifies its entries with Git. A read
   * of the same folder still running, with no change seen since, is joined.
   */
  readonly list: (
    checkout: CheckoutTarget,
    path: string,
    report?: boolean,
  ) => Effect.Effect<DirectoryListing, EditorFailure>;
  /** Runs a workspace command in the checkout's reads, which closing it ends, reporting failures. */
  readonly read: <A>(
    checkout: CheckoutTarget,
    effect: Effect.Effect<A, WorkspaceError>,
    report?: boolean,
  ) => Effect.Effect<A, WorkspaceError>;
  /**
   * Refreshes a checkout's listings, Git status and comparison. A refresh asked for while one runs
   * joins it, and runs it once more after.
   */
  readonly refresh: (checkout: CheckoutTarget, steps: RefreshSteps) => Effect.Effect<void>;
};

/** The editor's reads of its checkouts: watches, listings, Git status and comparisons. */
export class EditorDiscovery extends Context.Service<EditorDiscovery, EditorDiscoveryShape>()(
  'moonbase/editor/EditorDiscovery',
) {
  static readonly layer = (options: { watchRetryMs?: readonly number[] } = {}) =>
    Layer.effect(
      EditorDiscovery,
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        const session = yield* EditorSession;
        const alerts = yield* EditorAlerts;
        const views = yield* EditorViews;
        // Each checkout's watch and reads run in a scope under the session's, so closing the
        // editor ends them all.
        const root = session.scope;
        const state = yield* SubscriptionRef.make(emptyDiscovery);
        const changed = yield* PubSub.unbounded<CheckoutTarget>();
        const update = (f: (state: DiscoveryState) => DiscoveryState) =>
          SubscriptionRef.update(state, f);
        /** Per checkout, the scope its watch and reads run in. */
        const observations = new Map<string, Scope.Closeable>();
        const reads = new Map<string, ListingRead>();
        /** Per folder, a superseded Git classification left to finish. */
        const kept = new Map<string, Scope.Closeable>();
        /** Per folder, the read whose classification was shown last. */
        const classified = new Map<string, ListingRead>();
        const refreshing = new Map<string, { fiber: Fiber.Fiber<void>; again: boolean }>();

        const checkoutScope = (checkout: CheckoutTarget) =>
          observations.get(checkoutKey(checkout)) ?? root;
        /** Runs `effect` in `scope`, so closing the scope ends it, reporting a failure. */
        const runIn = <A, E>(scope: Scope.Scope, effect: Effect.Effect<A, E>, report = true) =>
          Effect.flatMap(Effect.forkIn(effect, scope, { startImmediately: true }), Fiber.join).pipe(
            Effect.tapError((error) => (report ? alerts.report(error) : Effect.void)),
          );

        const release = (checkout: CheckoutTarget) =>
          Effect.gen(function* () {
            const key = checkoutKey(checkout);
            yield* update((s) => ({ ...s, lostWatches: s.lostWatches.filter((k) => k !== key) }));
            const scope = observations.get(key);
            if (!scope) return;
            observations.delete(key);
            yield* Scope.close(scope, Exit.void);
          });

        const observe: EditorDiscoveryShape['observe'] = (checkout, { isOpen, onChanged }) =>
          Effect.gen(function* () {
            const key = checkoutKey(checkout);
            yield* release(checkout);
            const scope = yield* Scope.fork(root);
            observations.set(key, scope);
            const isCurrent = Effect.sync(() => observations.get(key) === scope);
            const live = Effect.map(
              Effect.all([isOpen, isCurrent]),
              ([open, current]) => open && current,
            );
            const receive = (event: WorkspaceEvent, rewatched: boolean, up: Effect.Effect<void>) =>
              Effect.gen(function* () {
                if (!sameCheckout(event.checkout, checkout) || !(yield* live)) return;
                // The host's text reaches the UI only as fixed text.
                if (event.error) yield* alerts.report(new EditorError({ reason: 'host-reported' }));
                if (event.ready) {
                  const first = !wasUp;
                  wasUp = true;
                  yield* up;
                  // A re-watch's first ready is its change: what was missed while it was down,
                  // read only now that no later change can slip past the live watch.
                  if (!first || !rewatched) return;
                }
                for (const read of reads.values()) read.stale = true;
                yield* PubSub.publish(changed, checkout);
                yield* onChanged(isCurrent);
              });
            let wasUp = false;
            const watch = retryWatch(
              (rewatched, up) => {
                wasUp = false;
                return workspace
                  .watch({ checkout, paths: [''] })
                  .pipe(Stream.runForEach((event) => receive(event, rewatched, up)));
              },
              {
                retryMs: options.watchRetryMs ?? watchRetry.retryMs,
                healthyMs: watchRetry.healthyMs,
                isRetryable: isUnavailable,
              },
            ).pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  if (!(yield* live)) return;
                  yield* update((s) => ({ ...s, lostWatches: [...s.lostWatches, key] }));
                  yield* alerts.report(error);
                }),
              ),
            );
            yield* Effect.forkIn(watch, scope, { startImmediately: true });
          });

        const list: EditorDiscoveryShape['list'] = (checkout, path, report = true) =>
          Effect.gen(function* () {
            yield* views.view(checkout);
            if (!isRelativePath(path, true))
              return yield* new EditorError({ reason: 'invalid-path' });
            const key = listingKey(checkout, path),
              scope = checkoutScope(checkout),
              pending = reads.get(key);
            if (pending?.scope === scope && !pending.listed && !pending.stale) {
              // A caller that reports joining a quiet read reports its failure, once.
              if (report && !pending.report) {
                pending.report = true;
                yield* Effect.forkIn(
                  Effect.catch(Deferred.await(pending.done), alerts.report),
                  scope,
                );
              }
              return yield* Deferred.await(pending.done);
            }
            // A newer read cancels the Git classification it replaces, except for one kept running
            // per folder: refreshes that come faster than Git answers would otherwise keep every
            // entry on its last classification, so a file un-ignored by a .gitignore edit would
            // stay dimmed.
            const keep = pending?.scope === scope && pending.classifying && !kept.has(key);
            if (keep) kept.set(key, pending.classificationScope);
            const read: ListingRead = {
              scope,
              classificationScope: yield* Scope.fork(scope),
              listed: false,
              classifying: false,
              stale: false,
              report,
              done: yield* Deferred.make<DirectoryListing, EditorFailure>(),
            };
            if (pending) pending.successor = read;
            reads.set(key, read);
            // Closed only once this read replaced it, so its end can't take it for the current.
            if (pending && !keep) yield* Scope.close(pending.classificationScope, Exit.void);
            const isOpen = Effect.map(
              views.get,
              ({ recovery }) =>
                scope.state._tag !== 'Closed' &&
                recovery.openCheckoutIds.includes(checkout.checkoutId),
            );
            const isCurrent = Effect.map(isOpen, (open) => open && reads.get(key) === read);
            /** Whether a read newer than this one already shows its classification. */
            const newerShown = () => {
              const shown = classified.get(key);
              for (let next = read.successor; next; next = next.successor)
                if (next === shown) return true;
              return false;
            };
            const work = Effect.gen(function* () {
              const listed = yield* Effect.exit(
                runIn(
                  scope,
                  workspace.listDirectory({ checkout, path, includeIgnoredStatus: false }),
                  read.report,
                ),
              );
              if (Exit.isFailure(listed)) {
                yield* Deferred.failCause(read.done, listed.cause);
                return;
              }
              const listing = listed.value;
              if (yield* isCurrent) {
                read.listed = true;
                read.shownClassification = classified.get(key);
                yield* update((s) => ({
                  ...s,
                  listings: { ...s.listings, [key]: keepClassification(listing, s.listings[key]) },
                }));
              }
              yield* Deferred.succeed(read.done, listing);
              if (
                !(yield* isCurrent) ||
                !listing.entries.some((entry) => entry.ignored === undefined)
              )
                return;
              read.classifying = true;
              const answer = yield* Effect.exit(
                runIn(
                  read.classificationScope,
                  workspace.getIgnoredPaths({
                    checkout,
                    path,
                    paths: listing.entries.map((entry) => entry.path),
                  }),
                  read.report,
                ),
              );
              if (Exit.isFailure(answer)) {
                // Without an answer, entries show as unclassified, not a stale classification.
                if ((yield* isCurrent) && classified.get(key) === read.shownClassification)
                  yield* update((s) => ({
                    ...s,
                    listings: {
                      ...s.listings,
                      [key]: { ...s.listings[key], entries: listing.entries },
                    },
                  }));
                return;
              }
              const ignored = answer.value;
              if (!(yield* isOpen) || newerShown()) return;
              const current = yield* isCurrent;
              const shown = (yield* SubscriptionRef.get(state)).listings[key];
              // Only an answer that replaces the shown flags counts as the newest classification.
              if (current || (!ignored.error && shown)) classified.set(key, read);
              if (current)
                yield* update((s) => ({
                  ...s,
                  listings: { ...s.listings, [key]: classify(listing, ignored) },
                }));
              else if (!ignored.error && shown)
                yield* update((s) => ({
                  ...s,
                  listings: {
                    ...s.listings,
                    [key]: classifyShown(s.listings[key], listing.entries, ignored.paths),
                  },
                }));
            }).pipe(
              Effect.ensuring(
                Effect.suspend(() => {
                  if (reads.get(key) === read) reads.delete(key);
                  if (kept.get(key) === read.classificationScope) kept.delete(key);
                  return Scope.close(read.classificationScope, Exit.void);
                }),
              ),
              Effect.onInterrupt(() => Deferred.interrupt(read.done).pipe(Effect.asVoid)),
            );
            // The checkout's watch may have been released while the replaced classification
            // closed: work forked into its closed scope would never run or settle, so the read
            // ends at once instead, as the checkout's other reads did.
            yield* Effect.uninterruptible(
              Effect.suspend(() => {
                if (scope.state._tag !== 'Closed')
                  return Effect.asVoid(Effect.forkIn(work, scope, { startImmediately: true }));
                if (reads.get(key) === read) reads.delete(key);
                return Effect.andThen(
                  Scope.close(read.classificationScope, Exit.void),
                  Deferred.interrupt(read.done),
                );
              }),
            );
            return yield* Deferred.await(read.done);
          });

        const refresh: EditorDiscoveryShape['refresh'] = (checkout, steps) =>
          Effect.suspend(() => {
            const key = checkoutKey(checkout);
            const running = refreshing.get(key);
            if (running) {
              running.again = true;
              return Fiber.join(running.fiber);
            }
            const entry = { again: false } as { fiber: Fiber.Fiber<void>; again: boolean };
            const once = Effect.gen(function* () {
              yield* steps.refreshListings;
              if (!(yield* steps.isCurrent)) return;
              const status = yield* Effect.exit(
                runIn(checkoutScope(checkout), workspace.gitStatus({ checkout })),
              );
              // A failed status was reported; retained buffers stay usable.
              if (Exit.isSuccess(status) && (yield* steps.isCurrent))
                yield* update((s) => ({ ...s, git: { ...s.git, [key]: status.value } }));
              if (!(yield* steps.isCurrent)) return;
              yield* steps.refreshComparison;
            });
            const work = Effect.gen(function* () {
              do {
                entry.again = false;
                yield* once;
              } while (entry.again && (yield* steps.isCurrent));
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (refreshing.get(key) === entry) refreshing.delete(key);
                }),
              ),
            );
            return Effect.flatMap(Effect.forkIn(work, checkoutScope(checkout)), (fiber) => {
              entry.fiber = fiber;
              refreshing.set(key, entry);
              return Fiber.join(fiber);
            });
          });

        return {
          state,
          get: SubscriptionRef.get(state),
          update,
          changes: Stream.fromPubSub(changed),
          observe,
          release,
          isWatchLost: (checkout) =>
            Effect.map(SubscriptionRef.get(state), (s) =>
              s.lostWatches.includes(checkoutKey(checkout)),
            ),
          list,
          read: (checkout, effect, report = true) => runIn(checkoutScope(checkout), effect, report),
          refresh,
        } satisfies EditorDiscoveryShape;
      }),
    );
}
