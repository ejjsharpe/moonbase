// Shared IPC controls for controlled hosts; provider/tool behavior stays in each behaviour module.
import { Effect, Stream } from 'effect';
import type { ChatServiceShape } from '@moonbase/contracts/services';

type ControlMessage = { type?: string; id?: string; operation?: string };

/**
 * Wraps the host's chat service to count, record and hold its requests, and answers the test's
 * stats, hold and release messages over IPC. `ended` settles once the test asks it to shut down
 * or goes away.
 */
export function hostControl(
  service: ChatServiceShape,
  stats: () => Record<string, unknown>,
  release?: () => void,
) {
  const commands: string[] = [],
    mutations: { operation: string; input: unknown; result: unknown }[] = [],
    heldReplies: string[] = [];
  let replyOperation: string | undefined,
    replyGate = Promise.resolve(),
    releaseReply = () => {};
  let watches = 0,
    publications = 0,
    activeWatches = 0;
  const bound = { ...service } as ChatServiceShape;
  for (const operation of Object.keys(service) as (keyof ChatServiceShape)[]) {
    if (operation === 'watch' || operation === 'watchChatList') continue;
    const run = service[operation] as unknown as (
      input: unknown,
    ) => Effect.Effect<unknown, unknown>;
    (bound as unknown as Record<string, unknown>)[operation] = (input: unknown) =>
      Effect.gen(function* () {
        commands.push(operation);
        const result = yield* run(input);
        if (['createChat', 'sendChat', 'stopChat'].includes(operation))
          mutations.push({
            operation,
            input: structuredClone(input),
            result: structuredClone(result),
          });
        if (operation === replyOperation) {
          heldReplies.push(operation);
          const gate = replyGate;
          yield* Effect.promise(() => gate);
        }
        return result;
      });
  }
  bound.watch = (input) =>
    Stream.unwrap(
      Effect.sync(() => {
        watches++;
        activeWatches++;
        return service.watch(input).pipe(
          Stream.tap(() => Effect.sync(() => void publications++)),
          Stream.ensuring(Effect.sync(() => void activeWatches--)),
        );
      }),
    );
  let end!: () => void;
  const ended = new Promise<void>((r) => (end = r));
  const control = (message: ControlMessage) => {
    if (message?.type === 'stats')
      process.send?.({
        id: message.id,
        ...stats(),
        watches,
        publications,
        activeWatches,
        commands: [...commands],
        mutations: [...mutations],
        heldReplies: [...heldReplies],
        replyOperation,
      });
    if (message?.type === 'hold-reply') {
      replyOperation = message.operation;
      replyGate = new Promise<void>((resolve) => {
        releaseReply = resolve;
      });
    }
    if (message?.type === 'release-reply') {
      replyOperation = undefined;
      releaseReply();
    }
    if (message?.type === 'release') release?.();
    if (message?.type === 'shutdown') {
      release?.();
      releaseReply();
      end();
    }
  };
  process.on('message', control);
  process.once('disconnect', () => {
    release?.();
    releaseReply();
    end();
  });

  return { bound, ended, close: () => process.off('message', control) };
}
