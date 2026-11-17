import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, SubscriptionRef } from 'effect';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { WorkspaceService } from '@moonbase/contracts/workspace-service';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';
import {
  EditorCheckouts,
  EditorLoader,
  EditorWorktrees,
  editorLayer,
} from '@moonbase/application/editor';

const main: CheckoutTarget = {
  hostId: 'local',
  checkoutId: 'main',
  projectId: 'moonbase',
  root: '/memory/moonbase',
  vcs: 'git',
  branch: 'main',
  worktree: 'main',
};

test('only the latest worktree listing applies, and a worktree made since joins it', async () => {
  const memory = fauxWorkspace([{ checkout: main, files: { 'a.ts': 'a' } }]);
  const held = Effect.runSync(Deferred.make<void>());
  let holdNext = false;
  // The workspace holds the next listing until the test lets it answer.
  const workspace = Layer.effect(
    WorkspaceService,
    Effect.map(WorkspaceService, (service) => ({
      ...service,
      listWorktrees: (input: Parameters<typeof service.listWorktrees>[0]) =>
        holdNext
          ? ((holdNext = false), Effect.andThen(Deferred.await(held), service.listWorktrees(input)))
          : service.listWorktrees(input),
    })),
  ).pipe(Layer.provide(memory.layer));
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(editorLayer({ clientId: 'worktrees' }), workspace),
  );
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* (yield* EditorLoader).load;
        const opened = yield* (yield* EditorCheckouts).openCheckout(main.root);
        const worktrees = yield* EditorWorktrees;
        holdNext = true;
        const stale = yield* Effect.forkChild(worktrees.list(opened), { startImmediately: true });
        yield* worktrees.list(opened);
        assert.deepEqual(SubscriptionRef.getUnsafe(worktrees.state), {
          checkoutId: 'main',
          roots: [main.root],
        });
        // The listing it replaced was cancelled, so it never answers over the newer one.
        yield* Fiber.join(stale);
        yield* Deferred.succeed(held, undefined);
        yield* worktrees.add('main', '/memory/moonbase-worktrees/chat-tidy');
        yield* worktrees.add('main', '/memory/moonbase-worktrees/chat-tidy');
        assert.deepEqual(SubscriptionRef.getUnsafe(worktrees.state)?.roots, [
          main.root,
          '/memory/moonbase-worktrees/chat-tidy',
        ]);
      }),
    );
  } finally {
    await runtime.dispose();
  }
});
