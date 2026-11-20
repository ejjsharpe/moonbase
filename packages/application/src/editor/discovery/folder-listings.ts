import {
  Cache,
  Deferred,
  Effect,
  Equal,
  Fiber,
  FiberMap,
  Hash,
  Ref,
  SubscriptionRef,
  type Scope,
} from 'effect';
import type { WorkspaceServiceShape } from '@moonbase/contracts/workspace-service';
import type { CheckoutTarget, DirectoryListing } from '@moonbase/contracts/workspace';
import type { WorkspaceError } from '@moonbase/contracts/workspace-errors';
import { keepClassification, listingKey, type DiscoveryState } from './discovery.ts';
import { makeFolderClassification } from './folder-classification.ts';

/** A folder of a checkout, compared by its `listingKey`, and whether its caller reports. */
class FolderKey implements Equal.Equal {
  readonly checkout: CheckoutTarget;
  readonly path: string;
  readonly loud: boolean;
  readonly key: string;
  constructor(checkout: CheckoutTarget, path: string, loud: boolean) {
    this.checkout = checkout;
    this.path = path;
    this.loud = loud;
    this.key = listingKey(checkout, path);
  }
  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof FolderKey && that.key === this.key;
  }
  [Hash.symbol](): number {
    return Hash.string(this.key);
  }
}

/** One listing read of a folder, which later callers join until it is listed or a change. */
type ListingRead = {
  readonly listed: Fiber.Fiber<DirectoryListing, WorkspaceError>;
  /** Shows the listing and classifies it, unless a newer read of the folder began first. */
  readonly shown: Fiber.Fiber<void>;
  /** Whether a caller reports the read's failures: one that joins a quiet read makes it loud. */
  readonly loud: Ref.Ref<boolean>;
  /** Reports the listing's failure, once however many callers report it. */
  readonly reportFailure: Effect.Effect<void>;
};

/**
 * The editor's folder listings. A read of a folder is joined until it is listed or a change makes
 * it stale (`invalidate`); a newer read keeps the older one's listing from showing, and cancels
 * its classification (see `makeFolderClassification`).
 */
export const makeFolderListings = (options: {
  readonly workspace: WorkspaceServiceShape;
  readonly state: SubscriptionRef.SubscriptionRef<DiscoveryState>;
  /** The scope the checkout's reads run in, which releasing the checkout closes. */
  readonly checkoutScope: (checkout: CheckoutTarget) => Effect.Effect<Scope.Scope>;
  readonly isOpen: (checkout: CheckoutTarget) => Effect.Effect<boolean>;
  readonly report: (error: unknown) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const { workspace, state, checkoutScope, report } = options;
    /** Per folder, the read whose listing shows next. */
    const showing = yield* FiberMap.make<string>();
    const isLive = (checkout: CheckoutTarget, scope: Scope.Scope) =>
      Effect.map(options.isOpen(checkout), (open) => open && scope.state._tag !== 'Closed');
    const classification = yield* makeFolderClassification({
      workspace,
      state,
      isLive,
      report,
    });

    /** Shows a read's listing, carrying the last classification over, then classifies it. */
    const showListing = (
      folder: FolderKey,
      scope: Scope.Scope,
      listed: Fiber.Fiber<DirectoryListing, WorkspaceError>,
      loud: Ref.Ref<boolean>,
    ) =>
      Effect.gen(function* () {
        const listing = yield* Fiber.join(listed);
        if (!(yield* isLive(folder.checkout, scope))) return;
        const shown = yield* SubscriptionRef.modify(state, (s) => {
          const shown = keepClassification(listing, s.listings[folder.key]);
          return [shown, { ...s, listings: { ...s.listings, [folder.key]: shown } }] as const;
        });
        if (!listing.entries.some((entry) => entry.ignored === undefined)) return;
        yield* classification.classify(folder, scope, listing, shown, loud);
      }).pipe(Effect.ignore);

    const reads: Cache.Cache<FolderKey, ListingRead> = yield* Cache.make({
      capacity: Number.POSITIVE_INFINITY,
      lookup: (folder: FolderKey) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const { checkout, path, key } = folder;
            // The read claims the folder's listing before anything can suspend it: a read admitted
            // after this one, once a change drops it from the cache, claims it after, so shows.
            const started = yield* Deferred.make<{
              readonly scope: Scope.Scope;
              readonly listed: Fiber.Fiber<DirectoryListing, WorkspaceError>;
            }>();
            const loud = yield* Ref.make(folder.loud);
            // Started once the read is cached, so its end can drop it from the cache: callers
            // after that read again.
            const shown = yield* FiberMap.run(
              showing,
              key,
              Effect.flatMap(Deferred.await(started), ({ scope, listed }) =>
                showListing(folder, scope, listed, loud),
              ).pipe(
                Effect.ensuring(
                  Effect.withFiber((self) =>
                    Cache.invalidateWhen(reads, folder, (read) => read.shown === self),
                  ),
                ),
              ),
              { startImmediately: false },
            );
            const scope = yield* checkoutScope(checkout);
            yield* classification.cancel(key);
            // Asked once the read is cached, so a change the request causes drops this read.
            const listed = yield* Effect.forkIn(
              workspace.listDirectory({
                checkout,
                path,
                includeIgnoredStatus: false,
              }),
              scope,
              { startImmediately: false },
            );
            yield* Deferred.succeed(started, { scope, listed });
            const reportFailure = yield* Effect.cached(
              Effect.catch(Fiber.join(listed), report).pipe(Effect.ignoreCause),
            );
            return { listed, shown, loud, reportFailure } satisfies ListingRead;
          }),
        ),
    });

    return {
      /** Lists a folder and shows it; see `EditorDiscoveryShape['list']`. */
      list: (checkout: CheckoutTarget, path: string, loud: boolean) =>
        Effect.gen(function* () {
          const read = yield* Cache.get(reads, new FolderKey(checkout, path, loud));
          if (loud) yield* Ref.set(read.loud, true);
          const listed = yield* Fiber.await(read.listed);
          yield* Fiber.await(read.shown);
          if (loud) yield* read.reportFailure;
          return yield* listed;
        }),
      /** A change was seen: callers read again rather than join a read begun before it. */
      invalidate: Cache.invalidateAll(reads),
    };
  });
