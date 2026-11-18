import { Context, Effect, Layer, SubscriptionRef } from 'effect';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { EditorError } from '../editor-errors.ts';
import { EditorSession } from '../session/session-service.ts';
import {
  emptyCheckoutView,
  emptyEditorRecovery,
  type CheckoutView,
} from '../recovery/recovery-layout.ts';
import { isCheckoutListed, type ViewsState } from './views.ts';

export type EditorViewsShape = {
  readonly state: SubscriptionRef.SubscriptionRef<ViewsState>;
  readonly get: Effect.Effect<ViewsState>;
  /** Changes a copy of the views: `f` may mutate the copy it is given, which then replaces them. */
  readonly modify: <A>(f: (draft: ViewsState) => A) => Effect.Effect<A>;
  /**
   * The checkout's view, once the editor is ready and knows this exact checkout (open, unless
   * `requireOpen` is false). A checkout without one gets an empty view.
   */
  readonly view: (
    checkout: CheckoutTarget,
    requireOpen?: boolean,
  ) => Effect.Effect<CheckoutView, EditorError>;
};

/** The editor's tabs and views, as its recovery layout keeps them. */
export class EditorViews extends Context.Service<EditorViews, EditorViewsShape>()(
  'moonbase/editor/EditorViews',
) {
  static readonly layer = Layer.effect(
    EditorViews,
    Effect.gen(function* () {
      const session = yield* EditorSession;
      const state = yield* SubscriptionRef.make<ViewsState>({
        recovery: emptyEditorRecovery(session.clientId),
        closed: [],
      });
      const modify = <A>(f: (draft: ViewsState) => A) =>
        SubscriptionRef.modify(state, (current) => {
          const draft = structuredClone(current) as ViewsState;
          const result = f(draft);
          return [result, draft] as const;
        });
      return {
        state,
        get: SubscriptionRef.get(state),
        modify,
        view: (checkout, requireOpen = true) =>
          Effect.gen(function* () {
            yield* session.assertReady;
            const { recovery } = yield* SubscriptionRef.get(state);
            if (
              !isCheckoutListed(recovery, checkout) ||
              (requireOpen && !recovery.openCheckoutIds.includes(checkout.checkoutId))
            )
              return yield* new EditorError({ reason: 'checkout-not-open' });
            const view = recovery.views.get(checkout.checkoutId);
            if (view) return view;
            return yield* modify((draft) => {
              const created = emptyCheckoutView();
              draft.recovery.views.set(checkout.checkoutId, created);
              return created;
            });
          }),
      } satisfies EditorViewsShape;
    }),
  );
}
