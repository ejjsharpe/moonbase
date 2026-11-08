import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acquireEditor } from './editor-model-fixture.ts';
import { checkout, fixture, held, target } from './editor-fixture.ts';
import type { EditorController } from '@moonbase/application/editor';

const treeOf = (editor: EditorController) =>
  editor.getSnapshot().recovery.views[checkout.checkoutId].tree;

test('reveal shows an ignored file by turning Hide Ignored Files off, unless told to skip it', async () => {
  const f = await fixture('reveal-ignored');
  try {
    f.editor.tree(checkout, { hideIgnored: true, selected: ['a.ts'], focus: 'a.ts' });
    assert.equal(await f.editor.reveal(target('c.ts'), { ignored: 'skip' }), false);
    assert.deepEqual(treeOf(f.editor).selected, ['a.ts']);
    assert.equal(treeOf(f.editor).hideIgnored, true);

    assert.equal(await f.editor.reveal(target('folder/nested.ts'), { ignored: 'skip' }), true);
    assert.deepEqual(treeOf(f.editor).selected, ['folder/nested.ts']);
    assert.equal(treeOf(f.editor).focus, 'folder/nested.ts');
    assert.deepEqual(treeOf(f.editor).expanded, ['folder']);
    assert.equal(treeOf(f.editor).hideIgnored, true);

    assert.equal(await f.editor.reveal(target('c.ts')), true);
    assert.deepEqual(treeOf(f.editor).selected, ['c.ts']);
    assert.equal(treeOf(f.editor).hideIgnored, false);
  } finally {
    await f.dispose();
  }
});

test('a newer reveal, or one no longer current, abandons a reveal still listing', async () => {
  const f = await fixture('reveal-source', false);
  const entered = held(),
    release = held();
  let holding = true;
  const editor = await acquireEditor(f.runtime, {
    clientId: 'reveal-stale',
    client: {
      ...f.client,
      watch: () => async () => {},
      async command(name, input, options) {
        if (holding && name === 'listDirectory' && (input as { path: string }).path === 'folder') {
          holding = false;
          entered.release();
          await release.promise;
        }
        return f.client.command(name, input, options);
      },
    },
  });
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    const stale = editor.reveal(target('folder/nested.ts'));
    await entered.promise;
    assert.equal(await editor.reveal(target('b.ts')), true);
    release.release();
    assert.equal(await stale, false);
    assert.deepEqual(treeOf(editor).selected, ['b.ts']);
    assert.deepEqual(treeOf(editor).expanded, []);

    let current = true;
    const abandoned = editor.reveal(target('folder/nested.ts'), { current: () => current });
    current = false;
    assert.equal(await abandoned, false);
    assert.deepEqual(treeOf(editor).selected, ['b.ts']);
  } finally {
    release.release();
    await editor.dispose();
    await f.dispose();
  }
});

test('Follow Active File is saved with the editor recovery and loads back', async () => {
  const f = await fixture('follow-setting');
  try {
    assert.equal(f.editor.getSnapshot().recovery.followActiveFile, true);
    f.editor.setFollowActiveFile(false);
    assert.equal(f.editor.getSnapshot().recovery.followActiveFile, false);
    await f.editor.flush();
    assert.equal(
      (await f.client.command('loadRecovery', { clientId: 'follow-setting' })).state
        .followActiveFile,
      false,
    );
    await f.editor.dispose();
    const reloaded = await acquireEditor(f.runtime, {
      client: { ...f.client, watch: () => async () => {} },
      clientId: 'follow-setting',
    });
    try {
      await reloaded.load();
      assert.equal(reloaded.getSnapshot().recovery.followActiveFile, false);
      reloaded.setFollowActiveFile(true);
      await reloaded.flush();
      assert.equal(
        (await f.client.command('loadRecovery', { clientId: 'follow-setting' })).state
          .followActiveFile,
        true,
      );
    } finally {
      await reloaded.dispose();
    }
  } finally {
    await f.dispose();
  }
});
