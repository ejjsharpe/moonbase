import { Context, Effect, Fiber, FiberHandle, FiberSet, Layer, Ref, SubscriptionRef } from 'effect';
import {
  emptyHistory,
  isSamePlace,
  settleStep,
  stepTo,
  visitPlace,
  type Place,
  type PlaceHistory,
} from './place-history.ts';

/** A place counts as visited once it has shown this long. */
export const placeSettleMs = 150;
/** A step back or forward that hasn't shown its place by now settles as it is. */
export const stepTimeoutMs = 3000;

/** A step back or forward on its way: until it is done, what shows isn't a visit of its own. */
type Step = { readonly place: Place; readonly from: number; readonly to: number };

export type PlaceNavigationShape = {
  readonly state: SubscriptionRef.SubscriptionRef<PlaceHistory>;
  /**
   * Tells the history the place showing now (null for none). A place counts once it settles: one
   * shown on the way, as when a project shows its last file before the one asked for opens, is
   * passed over. While a step is on its way, it only marks whether the step got there.
   */
  readonly show: (place: Place | null) => Effect.Effect<void>;
  /**
   * Steps to the place at `index`, which `go` shows. Once it is done (or has taken too long) and
   * has had a moment to show, the history follows what is showing; a newer step takes over.
   */
  readonly step: (index: number, go: Effect.Effect<void>) => Effect.Effect<void>;
};

/** The places the window has shown, for back and forward, as long as the window lasts. */
export class PlaceNavigation extends Context.Service<PlaceNavigation, PlaceNavigationShape>()(
  'moonbase/application/PlaceNavigation',
) {
  static readonly layer = Layer.effect(
    PlaceNavigation,
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make(emptyHistory);
      const showing = yield* Ref.make<Place | null>(null);
      const stepping = yield* Ref.make<{ step: Step; reached: boolean } | null>(null);
      /** The visit waiting for its place to settle. */
      const visiting = yield* FiberHandle.make<void, never>();
      /** The step waiting for its place: the latest one. */
      const settling = yield* FiberHandle.make<void, never>();
      /** Each step's showing, left to finish even once a newer step takes over. */
      const going = yield* FiberSet.make<void, never>();
      return {
        state,
        show: (place) =>
          Effect.gen(function* () {
            yield* Ref.set(showing, place);
            yield* FiberHandle.clear(visiting);
            if (!place) return;
            const current = yield* Ref.get(stepping);
            if (current) {
              if (isSamePlace(place, current.step.place))
                yield* Ref.set(stepping, { ...current, reached: true });
              return;
            }
            yield* FiberHandle.run(visiting)(
              Effect.sleep(placeSettleMs).pipe(
                Effect.andThen(SubscriptionRef.update(state, (h) => visitPlace(h, place))),
              ),
            );
          }),
        step: (index, go) =>
          Effect.gen(function* () {
            const history = yield* SubscriptionRef.get(state);
            const place = history.places[index];
            if (!place) return;
            const step: Step = { place, from: history.index, to: index };
            yield* FiberHandle.clear(visiting);
            yield* Ref.set(stepping, { step, reached: false });
            yield* SubscriptionRef.set(state, stepTo(history, index));
            const shown = yield* FiberSet.run(going)(go);
            yield* FiberHandle.run(settling)(
              Effect.gen(function* () {
                yield* Effect.timeoutOption(Fiber.await(shown), stepTimeoutMs);
                yield* Effect.sleep(placeSettleMs);
                // Settled at once, so a newer step can't come between reading and settling.
                yield* Effect.uninterruptible(
                  Effect.gen(function* () {
                    const current = yield* Ref.get(stepping);
                    if (current?.step !== step) return;
                    yield* Ref.set(stepping, null);
                    const now = yield* Ref.get(showing);
                    const reached = current.reached || (!!now && isSamePlace(now, place));
                    yield* SubscriptionRef.update(state, (h) =>
                      settleStep(h, { ...step, reached }, now),
                    );
                  }),
                );
              }),
            );
          }),
      } satisfies PlaceNavigationShape;
    }),
  );
}
