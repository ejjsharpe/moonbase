import { Effect, PubSub, Stream } from 'effect';
import type { RpcGroup } from 'effect/rpc';
import { WindowRpcs } from '../../ipc/window-rpcs.ts';
import type { WindowLifecycle } from '../window-lifecycle.ts';

/**
 * The window procedures: a document watching for actions is ready for them, and answers Quit.
 * Every watching document hears each action the lifecycle publishes.
 */
export const makeWindowIpcHandlers = (
  lifecycle: Pick<WindowLifecycle['Service'], 'actions' | 'markReady' | 'answerQuit'>,
) =>
  WindowRpcs.of({
    watchWindowActions: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(lifecycle.actions);
          // Subscribed first, so nothing published on becoming ready is missed.
          yield* lifecycle.markReady;
          return Stream.fromSubscription(subscription);
        }),
      ),
    answerQuit: lifecycle.answerQuit,
  } satisfies RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof WindowRpcs>>);
