import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acquireEditor } from '../../../test/fixtures/editor-model-fixture.ts';
import { checkout, fixture, held, target } from '../../../test/fixtures/editor-fixture.ts';
import { fileKey, type EditorController } from '@moonbase/application/editor';

const treeOf = (editor: EditorController) =>
  editor.getSnapshot().recovery.views[checkout.checkoutId].tree;

test('reveal shows an ignored file by turning Hide Ignored Files off, unless told to skip it', async () => {
  const f = await fixture('reveal-ignored');
  try {
    f.editor.tree(checkout, { hideIgnoredFiles: true, selected: ['a.ts'], focus: 'a.ts' });
    assert.equal(await f.editor.reveal(target('c.ts'), { ignored: 'skip' }), false);
    assert.deepEqual(treeOf(f.editor).selected, ['a.ts']);
    assert.equal(treeOf(f.editor).hideIgnoredFiles, true);

    assert.equal(await f.editor.reveal(target('folder/nested.ts'), { ignored: 'skip' }), true);
    assert.deepEqual(treeOf(f.editor).selected, ['folder/nested.ts']);
    assert.equal(treeOf(f.editor).focus, 'folder/nested.ts');
    assert.deepEqual(treeOf(f.editor).expanded, ['folder']);
    assert.equal(treeOf(f.editor).hideIgnoredFiles, true);

    assert.equal(await f.editor.reveal(target('c.ts')), true);
    assert.deepEqual(treeOf(f.editor).selected, ['c.ts']);
    assert.equal(treeOf(f.editor).hideIgnoredFiles, false);
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

    assert.equal(await editor.reveal(target('folder/nested.ts'), { current: () => false }), false);
    assert.deepEqual(treeOf(editor).selected, ['b.ts']);
  } finally {
    release.release();
    await editor.dispose();
    await f.dispose();
  }
});

/** An editor whose workspace commands are counted by name and can be held once. */
async function countedEditor(f: Awaited<ReturnType<typeof fixture>>, clientId: string) {
  const counts = new Map<string, number>(),
    hold: { path?: string; entered: ReturnType<typeof held>; release: ReturnType<typeof held> } = {
      entered: held(),
      release: held(),
    };
  const editor = await acquireEditor(f.runtime, {
    clientId,
    client: {
      ...f.client,
      watch: () => async () => {},
      async command(name, input, options) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
        if (name === 'listDirectory' && (input as { path: string }).path === hold.path) {
          hold.path = undefined;
          hold.entered.release();
          await hold.release.promise;
        }
        return f.client.command(name, input, options);
      },
    },
  });
  await editor.load();
  await editor.openCheckout(checkout.root);
  return { editor, counts, hold };
}
/** Waits until every listed entry under these folders has Git's classification. */
async function waitForClassification(editor: EditorController, folders: string[]) {
  for (let turn = 0; turn < 200; turn++) {
    const listings = editor.getSnapshot().listings;
    if (
      folders.every((folder) =>
        listings[fileKey(target(folder))]?.entries.every((entry) => entry.ignored !== undefined),
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Unclassified: ${folders.join(', ')}`);
}

test('revealing listed, classified levels again lists nothing and asks Git nothing', async () => {
  const f = await fixture('reveal-cached-source', false);
  const { editor, counts } = await countedEditor(f, 'reveal-cached');
  try {
    editor.tree(checkout, { hideIgnoredFiles: true });
    assert.equal(await editor.reveal(target('folder/nested.ts'), { ignored: 'skip' }), true);
    await waitForClassification(editor, ['', 'folder']);
    counts.clear();
    editor.tree(checkout, { expanded: [], selected: [], focus: '' });
    assert.equal(await editor.reveal(target('folder/nested.ts'), { ignored: 'skip' }), true);
    assert.deepEqual(treeOf(editor).expanded, ['folder']);
    assert.equal(await editor.reveal(target('b.ts'), { ignored: 'skip' }), true);
    // c.ts is already classified as ignored, so following skips it without asking Git again.
    assert.equal(await editor.reveal(target('c.ts'), { ignored: 'skip' }), false);
    assert.equal(counts.get('listDirectory') ?? 0, 0);
    assert.equal(counts.get('getIgnoredPaths') ?? 0, 0);
    assert.deepEqual(treeOf(editor).selected, ['b.ts']);
  } finally {
    await editor.dispose();
    await f.dispose();
  }
});

test('a quiet reveal reports nothing, and closing its checkout abandons it', async () => {
  const f = await fixture('reveal-quiet-source', false);
  const { editor, hold } = await countedEditor(f, 'reveal-quiet');
  try {
    await assert.rejects(editor.reveal(target('gone.ts'), { quiet: true }), /unavailable/);
    f.memory.failNext('listDirectory', 'Temporary listing failure');
    await assert.rejects(
      editor.reveal(target('folder/nested.ts'), { quiet: true }),
      /Temporary listing failure/,
    );
    assert.deepEqual(editor.getSnapshot().errors, []);
    // A manual reveal still reports.
    f.memory.failNext('listDirectory', 'Temporary listing failure');
    await assert.rejects(editor.reveal(target('folder/nested.ts')), /Temporary listing failure/);
    assert.deepEqual(editor.getSnapshot().errors, ['Temporary listing failure']);
    editor.clearErrors();

    hold.path = 'folder';
    const closing = editor.reveal(target('folder/nested.ts'), { quiet: true });
    await hold.entered.promise;
    assert.equal(await editor.closeCheckout(checkout), true);
    hold.release.release();
    assert.equal(await closing, false);
    assert.deepEqual(editor.getSnapshot().errors, []);
  } finally {
    hold.release.release();
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
