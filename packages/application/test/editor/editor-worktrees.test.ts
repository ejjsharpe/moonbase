import { acquireEditor } from './editor-model-fixture.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ManagedRuntime } from 'effect';
import { ApplicationError, type CheckoutTarget } from '@moonbase/contracts/workspace';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';

const main: CheckoutTarget = {
  hostId: 'local',
  checkoutId: 'main',
  projectId: 'moonbase',
  root: '/memory/moonbase',
  vcs: 'git' as const,
  branch: 'main',
  worktree: 'main',
};
const linked: CheckoutTarget = {
  ...main,
  checkoutId: 'linked',
  root: '/memory/moonbase-topic',
  vcs: 'git' as const,
  branch: 'topic',
  worktree: 'linked',
};
const other: CheckoutTarget = {
  ...main,
  checkoutId: 'other',
  projectId: 'other',
  root: '/memory/other',
};

async function fixture() {
  const memory = fauxWorkspace([
    { checkout: main, files: { 'a.ts': 'working' }, head: { 'a.ts': 'committed' } },
    { checkout: linked, files: { 'a.ts': 'topic' } },
    { checkout: other, files: {} },
  ]);
  const runtime = ManagedRuntime.make(memory.layer);
  const editor = await acquireEditor(runtime, {
    client: makeEditorClient(runtime),
    clientId: 'worktrees',
  });
  await editor.load();
  await editor.openCheckout(main.root);
  return {
    editor,
    async dispose() {
      await editor.dispose();
      await runtime.dispose();
    },
  };
}

test('the editor lists only the worktrees of an open checkout’s project, main first', async () => {
  const f = await fixture();
  try {
    assert.deepEqual((await f.editor.listWorktrees(main)).worktrees, [
      { root: main.root, branch: 'main', main: true, locked: false, prunable: false },
      { root: linked.root, branch: 'topic', main: false, locked: false, prunable: false },
    ]);
    await assert.rejects(f.editor.listWorktrees(other), ApplicationError.is);
  } finally {
    await f.dispose();
  }
});

test('createWorktree opens and selects the new linked checkout from the base commit', async () => {
  const f = await fixture();
  try {
    const created = await f.editor.createWorktree({
      checkout: main,
      base: 'main',
      branch: 'feature',
      location: '/memory/moonbase-feature',
    });
    assert.equal(created.vcs === 'git' && created.worktree, 'linked');
    assert.equal(created.projectId, main.projectId);
    const { recovery } = f.editor.getSnapshot();
    assert.deepEqual(recovery.openCheckoutIds, [main.checkoutId, created.checkoutId]);
    assert.equal(recovery.selectedCheckoutId, created.checkoutId);
    assert.equal(await f.editor.open({ checkout: created, path: 'a.ts' }), true);
    assert.equal(f.editor.buffer({ checkout: created, path: 'a.ts' })?.text, 'committed');
  } finally {
    await f.dispose();
  }
});

test('a refused worktree creation leaves the open checkouts unchanged', async () => {
  const f = await fixture();
  try {
    const before = f.editor.getSnapshot().recovery;
    await assert.rejects(
      f.editor.createWorktree({
        checkout: main,
        base: 'main',
        branch: 'topic',
        location: '/memory/elsewhere',
      }),
      (error) => ApplicationError.is(error) && error.code === 'Conflict',
    );
    assert.deepEqual(f.editor.getSnapshot().recovery.openCheckoutIds, before.openCheckoutIds);
    assert.equal(f.editor.getSnapshot().recovery.selectedCheckoutId, main.checkoutId);
  } finally {
    await f.dispose();
  }
});
