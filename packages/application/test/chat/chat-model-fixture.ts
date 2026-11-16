import { Effect, Exit, Layer, ManagedRuntime, Scope } from 'effect';
import {
  makeChatModel,
  makeChatController,
  type ChatDependencies,
} from '@moonbase/application/chat';
import { runApplicationEffect } from '@moonbase/application/runtime/effect-client';

/** A root runtime and scope for chat models; `layer` supplies services such as a `TestClock`. */
export function modelRoot(layer: Layer.Layer<never> = Layer.empty) {
  const runtime = ManagedRuntime.make(layer),
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
