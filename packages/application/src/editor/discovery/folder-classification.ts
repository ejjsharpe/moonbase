import { Cause, Effect, Exit, Fiber, FiberMap, Ref, SubscriptionRef, type Scope } from 'effect';
import type { WorkspaceServiceShape } from '@moonbase/contracts/workspace-service';
import type { CheckoutTarget, DirectoryListing } from '@moonbase/contracts/workspace';
import { classify, classifyShown, type DiscoveryState } from './discovery.ts';

/** A folder of a checkout, with its `listingKey`. */
export type ClassifiedFolder = {
  readonly checkout: CheckoutTarget;
  readonly path: string;
  readonly key: string;
};

/**
 * The Git classification of the folder listings shown. A newer listing cancels the classification
 * it replaces, except for one kept running per folder: refreshes that come faster than Git answers
 * would otherwise keep every entry on its last classification, so a file un-ignored by a
 * .gitignore edit would stay dimmed. Whichever answer applies last is the newest: the newest
 * listing's cancels the kept one.
 */
export const makeFolderClassification = (options: {
  readonly workspace: WorkspaceServiceShape;
  readonly state: SubscriptionRef.SubscriptionRef<DiscoveryState>;
  /** Whether the checkout is open and `scope`, its reads', is not yet closed. */
  readonly isLive: (checkout: CheckoutTarget, scope: Scope.Scope) => Effect.Effect<boolean>;
  readonly report: (error: unknown) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const { workspace, isLive, report } = options;
    /** Per folder, the classification of the listing shown. */
    const classifying = yield* FiberMap.make<string>();
    /** Per folder, a superseded classification left to finish. */
    const kept = yield* FiberMap.make<string>();
    const setListing = (key: string, f: (shown: DirectoryListing) => DirectoryListing) =>
      SubscriptionRef.update(options.state, (s) =>
        s.listings[key] ? { ...s, listings: { ...s.listings, [key]: f(s.listings[key]) } } : s,
      );

    /** A superseded classification's answer, which applies to the entries it classified. */
    const finishKept = (
      folder: ClassifiedFolder,
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
      folder: ClassifiedFolder,
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

    return {
      /** Classifies the listing just shown, as `shown`, with Git, replacing the folder's last. */
      classify: (
        folder: ClassifiedFolder,
        scope: Scope.Scope,
        listing: DirectoryListing,
        shown: DirectoryListing,
        loud: Ref.Ref<boolean>,
      ) =>
        FiberMap.run(classifying, folder.key, classifyListing(folder, scope, listing, shown, loud)),
      /** Cancels the folder's classification, as a newer listing of it begins. */
      cancel: (key: string) => FiberMap.remove(classifying, key),
    };
  });
