import {
  Cache,
  Deferred,
  Effect,
  Equal,
  Exit,
  Fiber,
  FiberMap,
  Hash,
  Ref,
  SubscriptionRef,
  type Scope,
} from 'effect';
import type {
  WorkspacePortError,
  WorkspaceServiceShape,
} from '@moonbase/contracts/workspace-service';
import type { CheckoutTarget, DirectoryListing } from '@moonbase/contracts/workspace';
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

/** A read's request, and the fiber that shows its listing unless a newer read began first. */
type ReadBegun = {
  readonly listed: Fiber.Fiber<DirectoryListing, WorkspacePortError>;
  readonly shown: Fiber.Fiber<void>;
};

/**
 * One listing read of a folder, which later callers join until it is listed or a change. The cache
 * holds it before it begins: only the read itself shows its listing or drops it from the cache,
 * unless the checkout's scope closed before it began, which ends it unbegun.
 */
type ListingRead = {
  /** Begins the read in the checkout's scope it was admitted in, so releasing that ends it. */
  readonly begun: Fiber.Fiber<ReadBegun>;
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
      listed: Fiber.Fiber<DirectoryListing, WorkspacePortError>,
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

    /**
     * Begins a cached read. The read claims the folder's listing before anything can suspend it,
     * so a read admitted after it (a change dropped it from the cache) claims it after, and shows.
     * Cancelling the last classification may read the folder again: that read finds this one cached
     * and joins it, as its request is not yet asked.
     */
    const beginRead = (
      folder: FolderKey,
      scope: Scope.Scope,
      loud: Ref.Ref<boolean>,
      isRead: (cached: ListingRead) => boolean,
    ) =>
      Effect.gen(function* () {
        const { checkout, path, key } = folder;
        const started = yield* Deferred.make<{
          readonly scope: Scope.Scope;
          readonly listed: Fiber.Fiber<DirectoryListing, WorkspacePortError>;
        }>();
        const shown = yield* FiberMap.run(
          showing,
          key,
          Effect.flatMap(Deferred.await(started), ({ scope, listed }) =>
            showListing(folder, scope, listed, loud),
          ).pipe(
            // The read's end drops it, never a later read, from the cache: callers read again.
            Effect.ensuring(Cache.invalidateWhen(reads, folder, isRead)),
          ),
          { startImmediately: false },
        );
        yield* classification.cancel(key);
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
        return { listed, shown } satisfies ReadBegun;
      }).pipe(Effect.uninterruptible);

    const reads: Cache.Cache<FolderKey, ListingRead> = yield* Cache.make({
      capacity: Number.POSITIVE_INFINITY,
      // Only allocates the read: it begins once cached, so nothing it starts can replace the entry.
      // The checkout's scope is taken here, as the read is admitted: releasing the checkout after
      // ends the read even before it begins, rather than it beginning in the next scope.
      lookup: (folder: FolderKey) =>
        Effect.gen(function* () {
          const scope = yield* checkoutScope(folder.checkout);
          const loud = yield* Ref.make(folder.loud);
          const begun = yield* Effect.forkIn(
            beginRead(folder, scope, loud, (cached) => cached.loud === loud),
            scope,
            { startImmediately: false },
          );
          const reportFailure = yield* Effect.cached(
            Fiber.join(begun).pipe(
              Effect.flatMap(({ listed }) => Effect.catch(Fiber.join(listed), report)),
              Effect.ignoreCause,
            ),
          );
          return { begun, loud, reportFailure } satisfies ListingRead;
        }),
    });

    return {
      /** Lists a folder and shows it; see `EditorDiscoveryShape['list']`. */
      list: (checkout: CheckoutTarget, path: string, loud: boolean) =>
        Effect.gen(function* () {
          const folder = new FolderKey(checkout, path, loud);
          const read = yield* Cache.get(reads, folder);
          if (loud) yield* Ref.set(read.loud, true);
          const started = yield* Fiber.await(read.begun);
          if (Exit.isFailure(started)) {
            // Its checkout's scope closed before it began, so nothing else drops it from the cache.
            yield* Cache.invalidateWhen(reads, folder, (cached) => cached === read);
            return yield* Effect.failCause(started.cause);
          }
          const begun = started.value;
          const listed = yield* Fiber.await(begun.listed);
          yield* Fiber.await(begun.shown);
          if (loud) yield* read.reportFailure;
          return yield* listed;
        }),
      /** A change was seen: callers read again rather than join a read begun before it. */
      invalidate: Cache.invalidateAll(reads),
    };
  });
