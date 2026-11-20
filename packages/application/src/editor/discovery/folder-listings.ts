import {
  Cache,
  Cause,
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
import type { WorkspaceServiceShape } from '@moonbase/contracts/workspace-service';
import type { CheckoutTarget, DirectoryListing } from '@moonbase/contracts/workspace';
import type { WorkspaceError } from '@moonbase/contracts/workspace-errors';
import {
  classify,
  classifyShown,
  keepClassification,
  listingKey,
  type DiscoveryState,
} from './discovery.ts';

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
 * The editor's folder listings and their Git classification. A read of a folder is joined until
 * it is listed or a change makes it stale (`invalidate`); a newer read keeps the older one's
 * listing from showing. A newer read also cancels the classification it replaces, except for
 * one kept running per folder: refreshes that come faster than Git answers would otherwise keep
 * every entry on its last classification, so a file un-ignored by a .gitignore edit would stay
 * dimmed. Whichever answer applies last is the newest: the newest read's cancels the kept one.
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
    /** Per folder, the classification of the listing shown. */
    const classifying = yield* FiberMap.make<string>();
    /** Per folder, a superseded classification left to finish. */
    const kept = yield* FiberMap.make<string>();
    const isLive = (checkout: CheckoutTarget, scope: Scope.Scope) =>
      Effect.map(options.isOpen(checkout), (open) => open && scope.state._tag !== 'Closed');
    const setListing = (key: string, f: (shown: DirectoryListing) => DirectoryListing) =>
      SubscriptionRef.update(state, (s) =>
        s.listings[key] ? { ...s, listings: { ...s.listings, [key]: f(s.listings[key]) } } : s,
      );

    /** A superseded classification's answer, which applies to the entries it classified. */
    const finishKept = (
      folder: FolderKey,
      scope: Scope.Scope,
      asked: Fiber.Fiber<{ paths: readonly string[]; error?: string }, unknown>,
      listing: DirectoryListing,
    ) =>
      Effect.gen(function* () {
        const answer = yield* Fiber.await(asked);
        if (
          Exit.isFailure(answer) ||
          answer.value.error ||
          !(yield* isLive(folder.checkout, scope))
        )
          return;
        yield* setListing(folder.key, (shown) =>
          classifyShown(shown, listing.entries, answer.value.paths),
        );
      }).pipe(Effect.onInterrupt(() => Fiber.interrupt(asked)));

    /** Classifies the listing just shown, as `shown`, with Git. */
    const classifyListing = (
      folder: FolderKey,
      scope: Scope.Scope,
      listing: DirectoryListing,
      shown: DirectoryListing,
      loud: Ref.Ref<boolean>,
    ) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const { checkout, path, key } = folder;
          const asked = yield* Effect.forkIn(
            workspace
              .getIgnoredPaths({
                checkout,
                path,
                paths: listing.entries.map((entry) => entry.path),
              })
              .pipe(
                Effect.tapError((error) =>
                  Effect.flatMap(Ref.get(loud), (loud) => (loud ? report(error) : Effect.void)),
                ),
              ),
            scope,
            { startImmediately: true },
          );
          // Superseded by a newer read: kept running if no other is, else cancelled.
          const keep = Effect.suspend(() =>
            FiberMap.hasUnsafe(kept, key)
              ? Fiber.interrupt(asked)
              : FiberMap.run(kept, key, finishKept(folder, scope, asked, listing)),
          );
          const answer = yield* restore(Fiber.await(asked)).pipe(Effect.onInterrupt(() => keep));
          if (Exit.isSuccess(answer)) {
            // The newest answer: the kept one, older, can no longer replace it.
            yield* FiberMap.remove(kept, key);
            if (yield* isLive(checkout, scope))
              yield* setListing(key, () => classify(listing, answer.value));
          } else if (!Cause.hasInterruptsOnly(answer.cause) && (yield* isLive(checkout, scope))) {
            // Without an answer, entries show as unclassified, not a stale classification, unless
            // the kept one classified them since.
            yield* setListing(key, (current) =>
              current === shown ? { ...current, entries: listing.entries } : current,
            );
          }
        }),
      );

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
        yield* FiberMap.run(
          classifying,
          folder.key,
          classifyListing(folder, scope, listing, shown, loud),
        );
      }).pipe(Effect.ignore);

    const reads: Cache.Cache<FolderKey, ListingRead> = yield* Cache.make({
      capacity: Number.POSITIVE_INFINITY,
      lookup: (folder: FolderKey) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const { checkout, path, key } = folder;
            const scope = yield* checkoutScope(checkout);
            yield* FiberMap.remove(classifying, key);
            const listed = yield* Effect.forkIn(
              workspace.listDirectory({ checkout, path, includeIgnoredStatus: false }),
              scope,
              { startImmediately: true },
            );
            const loud = yield* Ref.make(folder.loud);
            // Started once the read is cached, so its end can drop it from the cache: callers
            // after that read again. A newer read that replaced it began only once it was dropped.
            const shown = yield* FiberMap.run(
              showing,
              key,
              showListing(folder, scope, listed, loud).pipe(
                Effect.ensuring(
                  Effect.withFiber((self) =>
                    Cache.invalidateWhen(reads, folder, (read) => read.shown === self),
                  ),
                ),
              ),
              { startImmediately: false },
            );
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
