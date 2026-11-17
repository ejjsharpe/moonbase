import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Option } from 'effect';
import { WorkspaceService } from '@moonbase/contracts/workspace-service';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';
import {
  EditorCheckouts,
  EditorDiscovery,
  EditorLoader,
  editorLayer,
} from '@moonbase/application/editor';

const checkout: CheckoutTarget = {
  hostId: 'local',
  checkoutId: 'listing',
  projectId: 'project',
  root: '/memory/listing',
  vcs: 'git',
  branch: 'main',
  worktree: 'main',
};

test('a listing whose checkout closes while it replaces a classification still settles', async () => {
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'one', 'b.ts': 'two' } }]);
  const runtime = ManagedRuntime.make(memory.layer);
  const base = await runtime.runPromise(Effect.service(WorkspaceService));
  // Git never answers, and takes a moment to stop: the window where the checkout closes.
  const cancelling = await runtime.runPromise(Deferred.make<void>());
  const workspace = Layer.succeed(WorkspaceService, {
    ...base,
    getIgnoredPaths: () =>
      Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.andThen(Deferred.succeed(cancelling, undefined), Effect.sleep('30 millis')),
        ),
      ),
  });
  const editor = ManagedRuntime.make(Layer.provideMerge(editorLayer({ clientId: 'c' }), workspace));
  try {
    await editor.runPromise(
      Effect.gen(function* () {
        yield* (yield* EditorLoader).load;
        const opened = yield* (yield* EditorCheckouts).openCheckout(checkout.root);
        const discovery = yield* EditorDiscovery;
        // Opening listed the root once. The second read keeps that one's classification running;
        // the third cancels the second's, which takes a moment: the checkout closes meanwhile.
        yield* discovery.list(opened, '');
        const third = yield* Effect.forkChild(discovery.list(opened, ''));
        yield* Deferred.await(cancelling);
        yield* discovery.release(opened);
        const settled = yield* Effect.timeoutOption(Fiber.await(third), '5 seconds');
        assert(Option.isSome(settled), 'the listing settled');
        assert(Exit.isExit(settled.value));
      }),
    );
  } finally {
    await editor.dispose();
    await runtime.dispose();
  }
});
