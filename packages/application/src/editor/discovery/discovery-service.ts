import {
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  HashMap,
  Layer,
  Option,
  PubSub,
  RcMap,
  Ref,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect';
import { WorkspaceService, type WorkspacePortError } from '@moonbase/contracts/workspace-service';
import type {
  CheckoutTarget,
  DirectoryListing,
  WorkspaceEvent,
} from '@moonbase/contracts/workspace';
import { makeRunAgain } from '../../run-again.ts';
import { retryWatch, watchRetry } from '../../watch-retry.ts';
import { awaitForCaller } from '../await-for-caller.ts';
import { EditorError, isUnavailable, type EditorFailure } from '../editor-errors.ts';
import { isRelativePath } from '../relative-path.ts';
import { checkoutKey, sameCheckout } from '../recovery/recovery-references.ts';
import { EditorSession } from '../session/session-service.ts';
import { EditorAlerts } from '../alerts/alerts-service.ts';
import { EditorViews } from '../views/views-service.ts';
import { emptyDiscovery, type DiscoveryState } from './discovery.ts';
import { makeFolderListings } from './folder-listings.ts';

/** What a refresh of a checkout reads, given by the tabs that show it. */
export type RefreshSteps = {
  /** Whether the checkout is still open. */
  readonly isCurrent: Effect.Effect<boolean>;
  readonly refreshListings: Effect.Effect<void>;
  /** Reads the active file's comparison again, if one is shown. */
  readonly refreshComparison: Effect.Effect<void>;
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
  /**
   * Runs a workspace command in the checkout's reads, reporting failures. Closing the checkout ends
   * it, and so does interrupting the caller: it is a read only the caller wants.
   */
  readonly read: <A>(
    checkout: CheckoutTarget,
    effect: Effect.Effect<A, WorkspacePortError>,
    report?: boolean,
  ) => Effect.Effect<A, WorkspacePortError>;
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
        // Each checkout's reads run in its scope and its watch in `watches`, both under the
        // session's scope, so releasing the checkout ends them and closing the editor ends them all.
        const root = session.scope;
        const state = yield* SubscriptionRef.make(emptyDiscovery);
        const changed = yield* PubSub.unbounded<CheckoutTarget>();
        const update = (f: (state: DiscoveryState) => DiscoveryState) =>
          SubscriptionRef.update(state, f);
        const scopes = yield* Scope.provide(
          RcMap.make({ lookup: (_key: string) => Effect.scope, idleTimeToLive: Duration.infinity }),
          root,
        );
        const refreshes = yield* Scope.provide(makeRunAgain<string>(), root);
        /** Per checkout, its watch: a new watch replaces it, leaving the checkout's reads going. */
        const watches = yield* Scope.provide(FiberMap.make<string>(), root);
        /** Per checkout, the watch that holds it, which stays so once the watch is lost. */
        const holders = yield* Ref.make(HashMap.empty<string, object>());
        const checkoutScope = (checkout: CheckoutTarget) =>
          Effect.scoped(RcMap.get(scopes, checkoutKey(checkout)));
        const listings = yield* Scope.provide(
          makeFolderListings({
            workspace,
            state,
            checkoutScope,
            isOpen: (checkout) =>
              Effect.map(views.get, ({ recovery }) =>
                recovery.openCheckoutIds.includes(checkout.checkoutId),
              ),
            report: alerts.report,
          }),
          root,
        );
        /** Runs `effect` in the checkout's scope, so releasing it ends it, reporting a failure. */
        const runIn = <A, E>(checkout: CheckoutTarget, effect: Effect.Effect<A, E>) =>
          Effect.flatMap(checkoutScope(checkout), (scope) =>
            Effect.flatMap(Effect.forkIn(effect, scope, { startImmediately: true }), Fiber.join),
          ).pipe(Effect.tapError(alerts.report));

        /** Per checkout, a lock that makes its `observe` and `release` take turns. */
        const locks = yield* Scope.provide(
          RcMap.make({ lookup: (_key: string) => Semaphore.make(1) }),
          root,
        );
        const exclusively = <A>(key: string, effect: Effect.Effect<A>) =>
          Effect.scoped(Effect.flatMap(RcMap.get(locks, key), (lock) => lock.withPermit(effect)));

        /**
         * Hands the checkout to `holder` (none: to no watch) and stops the watch that held it, then
         * forgets its lost watch and ends its refresh. The old watch is stopped first, so nothing it
         * does while the refresh winds down can mark the checkout lost again.
         */
        const settle = (key: string, holder: Option.Option<object>) =>
          Effect.gen(function* () {
            yield* Ref.update(holders, (current) =>
              Option.match(holder, {
                onNone: () => HashMap.remove(current, key),
                onSome: (held) => HashMap.set(current, key, held),
              }),
            );
            yield* FiberMap.remove(watches, key);
            yield* update((s) => ({ ...s, lostWatches: s.lostWatches.filter((k) => k !== key) }));
            yield* refreshes.interrupt(key);
          });

        const release = (checkout: CheckoutTarget) => {
          const key = checkoutKey(checkout);
          return exclusively(
            key,
            Effect.andThen(settle(key, Option.none()), RcMap.invalidate(scopes, key)),
          );
        };

        const observe: EditorDiscoveryShape['observe'] = (checkout, { isOpen, onChanged }) =>
          Effect.gen(function* () {
            const key = checkoutKey(checkout);
            const holder = {};
            const isCurrent = Effect.map(Ref.get(holders), (current) =>
              Option.exists(HashMap.get(current, key), (held) => held === holder),
            );
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
                yield* listings.invalidate;
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
            yield* exclusively(
              key,
              Effect.andThen(settle(key, Option.some(holder)), FiberMap.run(watches, key, watch)),
            );
          });

        const list: EditorDiscoveryShape['list'] = (checkout, path, report = true) =>
          Effect.gen(function* () {
            yield* views.view(checkout);
            if (!isRelativePath(path, true))
              return yield* new EditorError({ reason: 'invalid-path' });
            return yield* listings.list(checkout, path, report);
          });

        const refresh: EditorDiscoveryShape['refresh'] = (checkout, steps) => {
          const key = checkoutKey(checkout);
          const once = Effect.gen(function* () {
            if (!(yield* steps.isCurrent)) return;
            yield* steps.refreshListings;
            if (!(yield* steps.isCurrent)) return;
            const status = yield* Effect.exit(runIn(checkout, workspace.gitStatus({ checkout })));
            // A failed status was reported; retained buffers stay usable.
            if (Exit.isSuccess(status) && (yield* steps.isCurrent))
              yield* update((s) => ({ ...s, git: { ...s.git, [key]: status.value } }));
            if (!(yield* steps.isCurrent)) return;
            yield* steps.refreshComparison;
          });
          return refreshes.run(key, once, { latest: true });
        };

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
          read: (checkout, effect, report = true) =>
            Effect.flatMap(checkoutScope(checkout), (scope) =>
              awaitForCaller(Effect.forkIn(effect, scope, { startImmediately: true }), Fiber.join),
            ).pipe(Effect.tapError((error) => (report ? alerts.report(error) : Effect.void))),
          refresh,
        } satisfies EditorDiscoveryShape;
      }),
    );
}
