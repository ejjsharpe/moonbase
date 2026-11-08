import { acquireEditor } from './editor-model-fixture.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ManagedRuntime } from 'effect';
import {
  ApplicationError,
  type CheckoutTarget,
  type EditorClient,
} from '@moonbase/contracts/workspace';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import { checkoutKey } from '@moonbase/application/editor';
import { memoryWorkspace } from '@moonbase/application/testing/memory-workspace';

const folder: CheckoutTarget = {
  hostId: 'local',
  checkoutId: 'notes',
  projectId: 'notes-folder',
  root: '/memory/notes',
  vcs: 'none',
};
const repository: CheckoutTarget = {
  hostId: 'local',
  checkoutId: 'repo',
  projectId: 'repo',
  root: '/memory/repo',
  vcs: 'git',
  branch: 'main',
  worktree: 'main',
};

async function fixture() {
  const memory = memoryWorkspace([
    { checkout: folder, files: { 'a.ts': 'a', 'b.ts': 'b' } },
    { checkout: repository, files: { 'r.ts': 'r' }, head: { 'r.ts': 'r' } },
  ]);
  const runtime = ManagedRuntime.make(memory.layer);
  const inner = makeEditorClient(runtime);
  const commands: string[] = [];
  const client: EditorClient = {
    command: (operation, input, options) => {
      commands.push(operation);
      return inner.command(operation, input, options);
    },
    watch: (...args) => inner.watch(...args),
  };
  const editor = await acquireEditor(runtime, { client, clientId: 'folders' });
  await editor.load();
  return {
    editor,
    memory,
    commands,
    inner,
    async dispose() {
      await editor.dispose();
      await runtime.dispose();
    },
  };
}

test('a plain-folder checkout opens and refreshes without reading Git status', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.editor.openCheckout(folder.root), folder);
    await f.editor.open({ checkout: folder, path: 'a.ts' }, { intent: 'keep' });
    await f.editor.refresh(folder);
    assert(!f.commands.includes('gitStatus'));
    assert.equal(f.editor.getSnapshot().git[checkoutKey(folder)], undefined);
    assert.deepEqual((await f.editor.listWorktrees(folder)).worktrees, []);
    await f.editor.openCheckout(repository.root);
    await assert.rejects(
      f.editor.initializeRepository(repository),
      (error: unknown) => ApplicationError.is(error) && error.code === 'InvalidInput',
    );
  } finally {
    await f.dispose();
  }
});

test('initializeRepository keeps the folder’s tabs and drafts on the Git checkout it becomes', async () => {
  const f = await fixture();
  try {
    await f.editor.openCheckout(folder.root);
    await f.editor.open({ checkout: folder, path: 'b.ts' }, { intent: 'keep' });
    await f.editor.open({ checkout: folder, path: 'a.ts' }, { intent: 'keep' });
    f.editor.edit({ checkout: folder, path: 'a.ts' }, 'unsaved');
    await f.editor.openCheckout(repository.root);
    await f.editor.selectCheckout(folder);

    const initialized = await f.editor.initializeRepository(folder);
    assert.equal(initialized.vcs, 'git');
    assert.equal(initialized.checkoutId, folder.checkoutId);
    const { recovery, buffers, git } = f.editor.getSnapshot();
    assert.deepEqual(recovery.checkouts, [initialized, repository]);
    assert.deepEqual(recovery.openCheckoutIds, [folder.checkoutId, repository.checkoutId]);
    assert.equal(recovery.selectedCheckoutId, initialized.checkoutId);
    assert.deepEqual(recovery.views[initialized.checkoutId].openFiles, ['b.ts', 'a.ts']);
    assert.equal(recovery.views[initialized.checkoutId].active, 'a.ts');
    assert(buffers.every((buffer) => buffer.target.checkout.vcs === 'git'));
    assert.equal(f.editor.buffer({ checkout: initialized, path: 'a.ts' })?.text, 'unsaved');
    assert.equal(f.editor.buffer({ checkout: folder, path: 'a.ts' }), undefined);
    // Git status is read for the new checkout: nothing is committed yet.
    assert.deepEqual(git[checkoutKey(initialized)]?.changes.map((change) => change.path).sort(), [
      'a.ts',
      'b.ts',
    ]);
    // The draft was published with the Git target, and saves to it.
    const saved = await f.inner.command('loadRecovery', { clientId: 'folders' });
    assert.deepEqual(
      saved.state.drafts.map((draft) => [draft.target.checkout, draft.target.path, draft.text]),
      [[initialized, 'a.ts', 'unsaved']],
    );
    assert.equal(await f.editor.save({ checkout: initialized, path: 'a.ts' }), true);
    assert.equal(
      (await f.inner.command('readFile', { checkout: initialized, path: 'a.ts' })).text,
      'unsaved',
    );
    await assert.rejects(f.editor.initializeRepository(folder), ApplicationError.is);
  } finally {
    await f.dispose();
  }
});

test('a failed initializeRepository leaves the plain folder open and observed', async () => {
  const f = await fixture();
  try {
    await f.editor.openCheckout(folder.root);
    await f.editor.open({ checkout: folder, path: 'a.ts' }, { intent: 'keep' });
    f.memory.failNext('initializeRepository', 'Git could not start.');
    await assert.rejects(f.editor.initializeRepository(folder), /Git could not start/);
    assert.deepEqual(f.editor.getSnapshot().recovery.checkouts, [folder]);
    // Its watch is back: a change on disk reaches the editor.
    const revision = f.editor.getSnapshot().discoveryRevision;
    f.memory.externalWrite({ checkout: folder, path: 'a.ts' }, 'changed outside');
    const deadline = Date.now() + 2000;
    while (f.editor.getSnapshot().discoveryRevision === revision && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert(f.editor.getSnapshot().discoveryRevision > revision);
  } finally {
    await f.dispose();
  }
});

test('reopening a closed folder that became a repository rebinds it instead of refusing', async () => {
  const f = await fixture();
  try {
    await f.editor.openCheckout(folder.root);
    assert.equal(await f.editor.closeCheckout(folder), true);
    const initialized = await f.inner.command('initializeRepository', { checkout: folder });
    assert.deepEqual(await f.editor.openCheckout(folder.root), initialized);
    assert.deepEqual(f.editor.getSnapshot().recovery.checkouts, [initialized]);
  } finally {
    await f.dispose();
  }
});
