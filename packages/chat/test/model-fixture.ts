import { Effect, Exit, Layer, ManagedRuntime, Scope } from 'effect';
import { makeChatModel, makeChatController, type ChatDependencies } from '@moonbase/chat';
import { runApplicationEffect } from '@moonbase/application/runtime/effect-client';

export function modelRoot() {
  const runtime = ManagedRuntime.make(Layer.empty),
    scope = Scope.makeUnsafe();
  return {
    runtime,
    async make(dependencies: ChatDependencies) {
      const model = await runApplicationEffect(
        runtime,
        Effect.provideService(makeChatModel(dependencies), Scope.Scope, scope),
      );
      return makeChatController(runtime, model);
    },
    async close() {
      try {
        await runApplicationEffect(runtime, Scope.close(scope, Exit.void));
      } finally {
        await runtime.dispose();
      }
    },
  };
}
