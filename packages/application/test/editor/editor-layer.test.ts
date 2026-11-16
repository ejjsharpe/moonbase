import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Layer, ManagedRuntime, SubscriptionRef } from 'effect';
import { WorkspaceService } from '@moonbase/contracts/services';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';
import {
  EditorBuffers,
  EditorCheckouts,
  EditorLoader,
  EditorMutations,
  EditorSaves,
  EditorTabs,
  RecoverySync,
  editorLayer,
} from '@moonbase/application/editor';

const checkout: CheckoutTarget = {
  hostId: 'local',
  checkoutId: 'headless',
  projectId: 'project',
  root: '/memory/headless',
  vcs: 'git',
  branch: 'main',
  worktree: 'main',
};

// D16: a non-React client uses the services alone, with no atoms and no Promise driver.
test('the editor saves and moves a file through its services alone', async () => {
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'one', 'b.ts': 'two' } }]);
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(editorLayer({ clientId: 'headless' }), memory.layer),
  );
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* (yield* EditorLoader).load;
        yield* (yield* EditorCheckouts).openCheckout(checkout.root);
        const tabs = yield* EditorTabs;
        const a = { checkout, path: 'a.ts' };
        assert.equal(yield* tabs.open(a), true);
        yield* tabs.edit(a, 'changed');
        assert.equal(yield* (yield* EditorSaves).save(a), true);
        const result = yield* (yield* EditorMutations).mutate(
          { checkout, kind: 'move', paths: ['b.ts'] },
          { destination: 'c.ts' },
        );
        assert.deepEqual(
          { completed: result.completed, error: result.error },
          { completed: true, error: '' },
        );
        yield* (yield* RecoverySync).flush;
        const workspace = yield* WorkspaceService;
        assert.equal((yield* workspace.readFile(a)).text, 'changed');
        assert.equal((yield* workspace.readFile({ checkout, path: 'c.ts' })).text, 'two');
        const { buffers } = yield* SubscriptionRef.get((yield* EditorBuffers).state);
        assert.deepEqual(
          [...buffers.values()].map((buffer) => [
            buffer.target.path,
            buffer.text === buffer.disk.text,
          ]),
          [['a.ts', true]],
        );
        const { state } = yield* workspace.loadRecovery({ clientId: 'headless' });
        assert.equal(state.buffers.filter((buffer) => buffer.draft).length, 0);
      }),
    );
  } finally {
    await runtime.dispose();
  }
});
