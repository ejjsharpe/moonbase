import { Effect, PubSub, Stream } from 'effect';
import type { WindowAction } from '../../ipc/window-rpcs.ts';
import { WindowRpcs } from '../../ipc/window-rpcs.ts';
import type { WindowLifecycle } from '../window-lifecycle.ts';

/**
 * The window procedures: a document watching for actions is ready for them, and answers Quit.
 * Every watching document hears each action published to `actions`.
 */
export const makeWindowIpcHandlers = (
  actions: PubSub.PubSub<WindowAction>,
  lifecycle: () => Pick<WindowLifecycle, 'markReady' | 'answerQuit'>,
) =>
  WindowRpcs.of({
    watchWindowActions: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(actions);
          // Subscribed first, so nothing published on becoming ready is missed.
          yield* Effect.sync(() => lifecycle().markReady());
          return Stream.fromSubscription(subscription);
        }),
      ),
    answerQuit: (answer) =>
      Effect.sync(() => {
        void lifecycle().answerQuit(answer);
      }),
  });
