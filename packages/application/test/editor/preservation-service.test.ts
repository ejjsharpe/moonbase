import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Layer, ManagedRuntime, SubscriptionRef } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import { WorkspaceService } from '@moonbase/contracts/workspace-service';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';
import {
  EditorCheckouts,
  EditorLoader,
  UnsavedChangesGuard,
  EditorSession,
  EditorTabs,
  RecoveryOutbox,
  RecoverySync,
  editorLayer,
} from '@moonbase/application/editor';

const checkout: CheckoutTarget = {
  hostId: 'local',
  checkoutId: 'quit',
  projectId: 'project',
  root: '/memory/quit',
  vcs: 'git',
  branch: 'main',
  worktree: 'main',
};

test('a failed final layout edit vetoes Quit until a later flush keeps it', async () => {
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'original' } }]);
  const base = ManagedRuntime.make(memory.layer);
  const store = await base.runPromise(Effect.service(WorkspaceService));
  let loseLayout = false;
  const workspace = Layer.succeed(WorkspaceService, {
    ...store,
    updateLayout: (input) =>
      loseLayout
        ? Effect.fail(new ApplicationError({ code: 'Persistence', message: 'Layout lost' }))
        : store.updateLayout(input),
  });
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(editorLayer({ clientId: 'quit' }), workspace),
  );
  const target = { checkout, path: 'a.ts' };
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* (yield* EditorLoader).load;
        const opened = yield* (yield* EditorCheckouts).openCheckout(checkout.root);
        const file = { ...target, checkout: opened };
        const tabs = yield* EditorTabs;
        yield* tabs.open(file);
        yield* (yield* RecoverySync).flush;
        const session = yield* EditorSession;
        const guard = yield* UnsavedChangesGuard;
        const setAccepting = (open: boolean) =>
          session.update((s) => ({ ...s, acceptingActions: open }));
        // The last change before Quit is a layout edit the store loses.
        loseLayout = true;
        yield* tabs.position(file, 'file', { line: 1, column: 7, top: 20, left: 0 });
        yield* setAccepting(false);
        assert.equal(yield* guard.finishQuitPreparation, false);
        assert.notEqual(
          (yield* SubscriptionRef.get((yield* RecoveryOutbox).state)).failure,
          undefined,
        );
        assert.equal(yield* guard.recoveryReady, false);
        // Quit may go once a later flush keeps it.
        yield* setAccepting(true);
        loseLayout = false;
        yield* (yield* RecoverySync).flush;
        yield* setAccepting(false);
        assert.equal(yield* guard.finishQuitPreparation, true);
        const { state } = yield* store.loadRecovery({ clientId: 'quit' });
        const id = state.buffers.find((buffer) => buffer.target.path === 'a.ts')!.id;
        assert.deepEqual(state.views[opened.checkoutId].positions[id].file, {
          line: 1,
          column: 7,
          top: 20,
          left: 0,
        });
      }),
    );
  } finally {
    await runtime.dispose();
    await base.dispose();
  }
});
