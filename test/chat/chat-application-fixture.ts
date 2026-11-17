import { Effect, ManagedRuntime, SubscriptionRef } from 'effect';
import { MoonbaseApplication } from '@moonbase/application';
import type { ChatDependencies } from '@moonbase/application/chat';

/** A chat-only application in its own runtime, started with its chat open. */
export async function openChatApplication(
  chat: () => ChatDependencies | Promise<ChatDependencies>,
) {
  const runtime: ManagedRuntime.ManagedRuntime<MoonbaseApplication, unknown> = ManagedRuntime.make(
    MoonbaseApplication.layer({
      chat: Effect.promise(async () => chat()),
      runner: { runPromiseExit: (effect, options) => runtime.runPromiseExit(effect, options) },
    }),
  );
  const app = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* MoonbaseApplication;
    }),
  );
  await runtime.runPromise(app.start);
  const { controller } = await runtime.runPromise(SubscriptionRef.get(app.chat.state));
  if (!controller) throw Error('The chat did not open.');
  return {
    chat: controller,
    async dispose() {
      try {
        await runtime.runPromise(app.release);
      } finally {
        await runtime.dispose();
      }
    },
  };
}
