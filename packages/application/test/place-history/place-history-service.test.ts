import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Deferred, Effect, SubscriptionRef } from 'effect';
import { TestClock } from 'effect/testing';
import { PlaceNavigation, type Place } from '@moonbase/application';

const file = (path: string): Place => ({ kind: 'project', checkoutId: 'c', path });
const run = (body: (navigation: PlaceNavigation['Service']) => Effect.Effect<void>) =>
  Effect.runPromise(
    Effect.flatMap(PlaceNavigation, body).pipe(
      Effect.provide(PlaceNavigation.layer),
      Effect.provide(TestClock.layer()),
    ),
  );
const paths = (navigation: PlaceNavigation['Service']) => {
  const { places, index } = SubscriptionRef.getUnsafe(navigation.state);
  return { places: places.map((place) => (place.kind === 'project' ? place.path : null)), index };
};

test('a place counts once it settles, and one shown on the way is passed over', () =>
  run((navigation) =>
    Effect.gen(function* () {
      yield* navigation.show(file('a'));
      yield* TestClock.adjust('150 millis');
      yield* navigation.show(file('b'));
      yield* TestClock.adjust('50 millis');
      yield* navigation.show(file('c'));
      yield* TestClock.adjust('150 millis');
      assert.deepEqual(paths(navigation), { places: ['a', 'c'], index: 1 });
    }),
  ));

test('a step settles on what shows once it is done; a newer step takes over', () =>
  run((navigation) =>
    Effect.gen(function* () {
      for (const path of ['a', 'b', 'c']) {
        yield* navigation.show(file(path));
        yield* TestClock.adjust('150 millis');
      }
      // Back to b: what shows on the way is no visit of its own.
      const reached = yield* Deferred.make<void>();
      yield* navigation.step(1, Deferred.await(reached));
      yield* navigation.show(file('x'));
      yield* navigation.show(file('b'));
      // A newer step back to a before b is done: only it settles, after its place shows.
      yield* navigation.step(0, navigation.show(file('a')));
      yield* Deferred.succeed(reached, undefined);
      yield* TestClock.adjust('150 millis');
      assert.deepEqual(paths(navigation), { places: ['a', 'b', 'c'], index: 0 });
      // A step whose place never shows (a file since deleted) drops it once it times out.
      yield* navigation.step(2, Effect.never);
      yield* TestClock.adjust('3150 millis');
      assert.deepEqual(paths(navigation), { places: ['a', 'b'], index: 0 });
    }),
  ));
