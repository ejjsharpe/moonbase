import { Context, Effect, Fiber, FiberHandle, Layer, SubscriptionRef } from 'effect';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { EditorCheckouts } from '../checkouts/checkouts-service.ts';
import { addWorktreeRoot, type ListedWorktrees } from './worktrees.ts';

export type EditorWorktreesShape = {
  /** The roots of the worktrees last listed, for one checkout at a time. */
  readonly state: SubscriptionRef.SubscriptionRef<ListedWorktrees | null>;
  /**
   * Lists a checkout's worktrees. Only the latest listing applies: a newer one cancels it. A
   * failed listing keeps the last good roots (the checkouts service reports why).
   */
  readonly list: (checkout: CheckoutTarget) => Effect.Effect<void>;
  /** Adds a worktree made since the listing, so it counts before the next one. */
  readonly add: (checkoutId: string, root: string) => Effect.Effect<void>;
};

/** The worktrees of the project a view shows, such as the project dock's. */
export class EditorWorktrees extends Context.Service<EditorWorktrees, EditorWorktreesShape>()(
  'moonbase/editor/EditorWorktrees',
) {
  static readonly layer = Layer.effect(
    EditorWorktrees,
    Effect.gen(function* () {
      const checkouts = yield* EditorCheckouts;
      const state = yield* SubscriptionRef.make<ListedWorktrees | null>(null);
      const listing = yield* FiberHandle.make<void, never>();
      return {
        state,
        list: (checkout) =>
          Effect.flatMap(
            FiberHandle.run(listing)(
              checkouts.listWorktrees(checkout).pipe(
                Effect.flatMap((result) =>
                  SubscriptionRef.set(state, {
                    checkoutId: checkout.checkoutId,
                    roots: result.worktrees.map((worktree) => worktree.root),
                  }),
                ),
                Effect.ignore,
              ),
            ),
            Fiber.await,
          ).pipe(Effect.asVoid),
        add: (checkoutId, root) =>
          SubscriptionRef.update(state, (listed) => addWorktreeRoot(listed, checkoutId, root)),
      } satisfies EditorWorktreesShape;
    }),
  );
}
