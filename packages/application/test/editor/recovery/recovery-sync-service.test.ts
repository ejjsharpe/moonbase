import { fileKey } from '@moonbase/application/editor';
import {
  acquireEditor,
  checkout,
  second,
  target,
  fixture,
  loadStoredState,
  draftsOf,
} from '../editor-fixture.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('restart reconciles recorded outcomes only in their immutable checkout despite colliding source paths', async () => {
  const f = await fixture('editor-one', false);
  try {
    await f.editor.openCheckout(second.root);
    for (const c of [checkout, second]) {
      await f.editor.open(target('a.ts', c));
      f.editor.edit(target('a.ts', c), c.hostId + ' dirty');
    }
    await f.editor.flush();
    const sources = await f.editor.inspect(checkout, ['a.ts']);
    f.memory.failNext('mutate', 'Lost after move', true);
    await assert.rejects(
      f.editor.mutate({
        id: 'restart-move',
        checkout,
        sources,
        kind: 'move',
        destination: 'moved.ts',
      }),
    );
    await f.editor.dispose();
    const restored = await acquireEditor(f.runtime, {
      client: f.client,
      clientId: f.editor.clientId,
    });
    try {
      await restored.load();
      assert.equal(restored.buffer(target('moved.ts'))!.text, 'local dirty');
      assert.equal(restored.buffer(target('a.ts', second))!.text, 'other-host dirty');
      assert.equal(restored.buffer(target('moved.ts', second)), undefined);
      assert.equal(f.memory.stats.mutations, 1);
    } finally {
      await restored.dispose();
    }
  } finally {
    await f.dispose();
  }
});

test('origin acknowledgement cannot hide a move from another observer; the observer acknowledges once it follows', async () => {
  const f = await fixture('origin', false);
  // The observer follows the store only when asked, so it edits before it hears of the move.
  const observer = await acquireEditor(f.runtime, {
    client: { ...f.client, watch: () => async () => {}, watchRecovery: () => async () => {} },
    clientId: 'observer',
  });
  try {
    await observer.load();
    await observer.openCheckout(checkout.root);
    for (const editor of [f.editor, observer]) {
      await editor.open(target('a.ts'));
      editor.edit(target('a.ts'), editor.clientId + ' draft');
      await editor.flush();
    }
    const baseline = observer.buffer(target('a.ts'))!.disk;
    const sources = await f.editor.inspect(checkout, ['a.ts']);
    await f.editor.mutate({
      id: 'shared-result',
      checkout,
      sources,
      kind: 'move',
      destination: 'moved.ts',
    });
    assert.equal(
      (await f.client.command('loadRecovery', { clientId: 'origin' })).operations.length,
      0,
    );
    const evidence = await f.client.command('loadRecovery', { clientId: 'observer' });
    assert.equal(evidence.operations[0].clientId, 'origin');
    assert.equal(evidence.operations[0].id, 'shared-result');
    observer.edit(target('a.ts'), 'newer live observer text');
    await observer.reconcileRecovery();
    assert.equal(observer.buffer(target('a.ts')), undefined);
    assert.equal(observer.buffer(target('moved.ts'))!.text, 'newer live observer text');
    assert.deepEqual(observer.buffer(target('moved.ts'))!.disk, baseline);
    assert.equal(
      (await f.client.command('loadRecovery', { clientId: 'observer' })).operations.length,
      0,
    );
    assert.equal(f.memory.stats.mutations, 1);
  } finally {
    await observer.dispose();
    await f.dispose();
  }
});

test("an observer's own Save does not rebase another dirty editor's baseline", async () => {
  const f = await fixture('origin', false),
    other = await acquireEditor(f.runtime, {
      client: { ...f.client, watch: () => async () => {} },
      clientId: 'other',
    });
  try {
    await other.load();
    await other.openCheckout(checkout.root);
    await other.open(target('a.ts'));
    other.edit(target('a.ts'), 'other draft');
    await other.flush();
    const baseline = other.buffer(target('a.ts'))!.disk;
    await f.editor.open(target('a.ts'));
    f.editor.edit(target('a.ts'), 'saved origin');
    await f.editor.flush();
    assert.equal(await f.editor.save(target('a.ts')), true);
    assert.deepEqual(
      draftsOf(await loadStoredState(f.client, other.clientId)).map((d) => d.disk),
      [baseline],
    );
    assert.equal(await other.save(target('a.ts')), false);
    assert.equal(other.buffer(target('a.ts'))!.text, 'other draft');
  } finally {
    await other.dispose();
    await f.dispose();
  }
});

test('pre-existing persisted replacement drafts survive a foreign move and controller restart', async () => {
  const f = await fixture('persisted-collision', false);
  try {
    await f.editor.open(target('a.ts'));
    f.editor.edit(target('a.ts'), 'original source draft');
    await f.editor.open(target('b.ts'));
    f.editor.edit(target('b.ts'), 'original destination draft');
    await f.editor.flush();
    const before = await f.client.command('loadRecovery', { clientId: f.editor.clientId });
    const sources = await f.client.command('inspectEntries', { checkout, paths: ['a.ts'] });
    const replacements = await f.client.command('inspectEntries', { checkout, paths: ['b.ts'] });
    await f.client.command('mutate', {
      id: 'persisted-replace',
      clientId: 'foreign',
      checkout,
      kind: 'move',
      sources,
      replacements,
      destination: 'b.ts',
    });
    const pending = await f.client.command('loadRecovery', { clientId: f.editor.clientId });
    assert.deepEqual(draftsOf(pending.state), draftsOf(before.state));
    assert.equal(pending.operations.length, 1);
    await f.editor.dispose();
    const restored = await acquireEditor(f.runtime, {
      client: f.client,
      clientId: f.editor.clientId,
    });
    try {
      await restored.load();
      assert.equal(restored.buffer(target('a.ts'))!.text, 'original source draft');
      assert.equal(restored.buffer(target('b.ts'))!.text, 'original destination draft');
      const retained = await f.client.command('loadRecovery', { clientId: restored.clientId });
      assert.equal(new Set(draftsOf(retained.state).map((draft) => fileKey(draft.target))).size, 2);
      // Followed with both drafts kept, the operation is acknowledged.
      assert.equal(retained.operations.length, 0);
      assert.equal(f.memory.stats.mutations, 1);
    } finally {
      await restored.dispose();
    }
  } finally {
    await f.dispose();
  }
});

test("another window's copy onto a clean tab gives the tab the copied draft, not its stale text", async () => {
  const f = await fixture('copy-onto-tab');
  const { editor } = f;
  try {
    await editor.open(target('a.ts'));
    editor.edit(target('a.ts'), 'SOURCE DRAFT');
    await editor.open(target('b.ts'), { intent: 'keep' });
    await editor.flush();
    // Another client of the store copies a.ts over b.ts, which this editor shows clean.
    await f.client.command('mutate', {
      id: 'copy-over',
      clientId: 'other-window',
      checkout,
      kind: 'copy',
      sources: await f.client.command('inspectEntries', { checkout, paths: ['a.ts'] }),
      replacements: await f.client.command('inspectEntries', { checkout, paths: ['b.ts'] }),
      destination: 'b.ts',
    });
    await editor.reconcileRecovery();
    await editor.flush();
    assert.equal(editor.buffer(target('b.ts'))?.text, 'SOURCE DRAFT');
    const { state } = await f.client.command('loadRecovery', { clientId: editor.clientId });
    const copied = state.buffers.find((b) => b.target.path === 'b.ts')?.draft;
    assert.equal(copied?.text, 'SOURCE DRAFT');
    assert.equal(copied?.disk.version, editor.buffer(target('b.ts'))?.disk.version);
  } finally {
    await f.dispose();
  }
});
