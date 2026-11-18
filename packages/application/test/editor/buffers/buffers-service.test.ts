import { fileKey } from '@moonbase/application/editor';
import { acquireEditor, checkout, target, fixture, draftsOf } from '../editor-fixture.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkspaceClient } from '@moonbase/application/testing/editor-fixture';

test('open/edit/save and staged/unstaged views use one working buffer and distinct baselines', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.editor.open(target('a.ts')), true);
    f.editor.edit(target('a.ts'), 'my edits');
    assert.equal(await f.editor.open(target('a.ts'), { view: 'staged' }), true);
    assert.equal(
      f.editor.getSnapshot().comparisons[fileKey(target('a.ts'))].original,
      'const a = 0;',
    );
    assert.equal(f.editor.buffer(target('a.ts'))?.text, 'my edits');
    await f.editor.open(target('a.ts'), { view: 'unstaged' });
    assert.equal(
      f.editor.getSnapshot().comparisons[fileKey(target('a.ts'))].original,
      'const a = 0.5;',
    );
    assert.equal(f.editor.getSnapshot().buffers.length, 1);
    assert.equal(await f.editor.save(target('a.ts')), true);
    assert.equal((await f.client.command('readFile', target('a.ts'))).text, 'my edits');
    assert.equal(
      (await f.client.command('readComparison', { target: target('a.ts'), area: 'unstaged' }))
        .original,
      'const a = 0.5;',
    );
  } finally {
    await f.dispose();
  }
});

for (const origin of ['own', 'foreign'] as const)
  test(`a draft opened at a move's destination is kept beside the arriving draft (${origin} move)`, async () => {
    const f = await fixture('collision', false);
    await f.editor.dispose();
    let reach!: () => void, release!: () => void;
    const reached = new Promise<void>((resolve) => {
        reach = resolve;
      }),
      wait = new Promise<void>((resolve) => {
        release = resolve;
      });
    const client: WorkspaceClient = {
      ...f.client,
      watch: () => async () => {},
      async command(name, input, options) {
        const result = await f.client.command(name, input, options);
        if (origin === 'own' && name === 'mutate') {
          reach();
          await wait;
        }
        return result;
      },
    };
    let editor = await acquireEditor(f.runtime, { client, clientId: 'collision-observer' });
    try {
      await editor.load();
      await editor.openCheckout(checkout.root);
      await editor.open(target('a.ts'));
      editor.edit(target('a.ts'), 'source edits');
      await editor.flush();
      const sources = await editor.inspect(checkout, ['a.ts']);
      let operation: Promise<unknown>;
      if (origin === 'own') {
        operation = editor.mutate({
          id: 'collision',
          checkout,
          sources,
          kind: 'move',
          destination: 'destination.ts',
        });
        await reached;
      } else {
        await f.client.command('mutate', {
          id: 'collision',
          clientId: 'foreign',
          checkout,
          sources,
          kind: 'move',
          destination: 'destination.ts',
        });
        operation = Promise.resolve();
      }
      await editor.open(target('destination.ts'));
      editor.edit(target('destination.ts'), 'destination edits');
      release();
      await operation;
      if (origin === 'foreign') await editor.reconcileRecovery();
      await editor.flush();
      // The source's draft moved with it; the draft opened over the file it replaced is kept
      // beside it, and both are durable.
      const kept = () => {
        const buffers = editor.getSnapshot().buffers;
        assert.equal(buffers.find((b) => b.target.path === 'destination.ts')?.text, 'source edits');
        const aside = buffers.find((b) => b.text === 'destination edits');
        assert(aside && aside.target.path !== 'destination.ts');
        assert.equal(editor.buffer(target('a.ts')), undefined);
      };
      kept();
      assert.match(editor.getSnapshot().errors.join(' '), /destination\.ts/);
      const retained = await f.client.command('loadRecovery', { clientId: editor.clientId });
      assert.deepEqual(
        draftsOf(retained.state)
          .map((draft) => draft.text)
          .sort(),
        ['destination edits', 'source edits'],
      );
      assert.equal(retained.operations.length, 0);
      assert.equal(f.memory.stats.mutations, 1);
      await editor.dispose();
      editor = await acquireEditor(f.runtime, { client, clientId: 'collision-observer' });
      await editor.load();
      kept();
      const recent = editor.getSnapshot().recovery.recentFiles.map(fileKey);
      assert.equal(new Set(recent).size, recent.length);
    } finally {
      release();
      await editor.dispose();
      await f.dispose();
    }
  });

test('text kept beside a replaced file saves by creating its own file, never replacing one', async () => {
  const f = await fixture('kept-text', false);
  const { editor } = f;
  try {
    await editor.open(target('a.ts'), { intent: 'keep' });
    await editor.open(target('b.ts'), { intent: 'keep' });
    await editor.flush();
    // An existing file holds the first free name, and the editor has listed it.
    await f.client.command('mutate', {
      id: 'occupy',
      clientId: 'other-window',
      checkout,
      kind: 'create-file',
      sources: [],
      destination: 'b (unsaved).ts',
      text: 'NOT YOURS',
    });
    await editor.list(checkout);
    // Text typed into b.ts is not yet sent when another client moves a.ts over it.
    editor.edit(target('b.ts'), 'typed over b');
    await f.client.command('mutate', {
      id: 'move-over',
      clientId: 'other-window',
      checkout,
      kind: 'move',
      sources: await f.client.command('inspectEntries', { checkout, paths: ['a.ts'] }),
      replacements: await f.client.command('inspectEntries', { checkout, paths: ['b.ts'] }),
      destination: 'b.ts',
    });
    await editor.reconcileRecovery();
    await editor.flush();
    const kept = target('b (unsaved 2).ts');
    assert.equal(editor.buffer(kept)?.text, 'typed over b');
    assert.match(editor.getSnapshot().errors.join(' '), /b \(unsaved 2\)\.ts/);
    // Saving creates the file with the text and leaves the other one as it was.
    assert.equal(await editor.save(kept, true), true);
    assert.equal((await f.client.command('readFile', kept)).text, 'typed over b');
    assert.equal((await f.client.command('readFile', target('b (unsaved).ts'))).text, 'NOT YOURS');
    assert.equal(editor.buffer(kept)?.text, editor.buffer(kept)?.disk.text);
    const { state } = await f.client.command('loadRecovery', { clientId: editor.clientId });
    assert.deepEqual(
      state.buffers.filter((b) => b.draft).map((b) => [b.target.path, b.draft!.text]),
      [],
    );
  } finally {
    await f.dispose();
  }
});
