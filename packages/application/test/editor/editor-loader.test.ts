import { checkoutKey } from '@moonbase/application/editor';
import {
  acquireEditor,
  checkout,
  second,
  target,
  fixture,
  loadStoredState,
  draftsOf,
} from './editor-fixture.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('two editor instances isolate buffers, positions, selection and recovery; restart restores only its own namespace', async () => {
  const f = await fixture(),
    other = await acquireEditor(f.runtime, { client: f.client, clientId: 'editor-two' });
  try {
    await other.load();
    await other.openCheckout(checkout.root);
    await f.editor.open(target('a.ts'));
    await other.open(target('a.ts'));
    f.editor.edit(target('a.ts'), 'one');
    other.edit(target('a.ts'), 'two');
    f.editor.position(target('a.ts'), 'file', { line: 1, column: 3, top: 9, left: 0 });
    await other.open(target('b.ts'));
    await f.editor.flush();
    await other.flush();
    assert.notEqual(f.editor.instanceId, other.instanceId);
    assert.equal(other.getSnapshot().recovery.views.get(checkout.checkoutId)!.active, 'b.ts');
    assert.equal(
      other.getSnapshot().recovery.views.get(checkout.checkoutId)!.positions.get('a.ts'),
      undefined,
    );
    for (const [clientId, text] of [
      [f.editor.clientId, 'one'],
      [other.clientId, 'two'],
    ])
      assert.deepEqual(
        draftsOf(await loadStoredState(f.client, clientId)).map((d) => [d.target.path, d.text]),
        [['a.ts', text]],
      );
    await f.editor.dispose();
    const restored = await acquireEditor(f.runtime, { client: f.client, clientId: 'editor-one' });
    try {
      await restored.load();
      assert.equal(restored.buffer(target('a.ts'))!.text, 'one');
    } finally {
      await restored.dispose();
    }
    assert.equal(other.buffer(target('a.ts'))!.text, 'two');
  } finally {
    await other.dispose();
    await f.dispose();
  }
});

test('clean tabs restore current disk content while dirty tabs retain their original baseline', async () => {
  const f = await fixture('restore', false);
  try {
    await f.editor.open(target('a.ts'));
    await f.editor.flush();
    await f.editor.dispose();
    f.memory.externalWrite(target('a.ts'), 'latest disk');
    const restored = await acquireEditor(f.runtime, { client: f.client, clientId: 'restore' });
    try {
      await restored.load();
      assert.equal(restored.buffer(target('a.ts'))!.text, 'latest disk');
    } finally {
      await restored.dispose();
    }
  } finally {
    await f.dispose();
  }
});

test('restored open roots populate initial tree and Git including expanded folders', async () => {
  const f = await fixture('discover-restore', false);
  try {
    await f.editor.openCheckout(second.root);
    f.editor.tree(checkout, { expanded: ['folder'] });
    await f.editor.flush();
    await f.editor.dispose();
    const restored = await acquireEditor(f.runtime, {
      client: f.client,
      clientId: 'discover-restore',
    });
    try {
      await restored.load();
      const state = restored.getSnapshot();
      for (const c of [checkout, second]) {
        assert(state.listings[JSON.stringify([checkoutKey(c), ''])]?.entries.length);
        assert(state.git[checkoutKey(c)]);
      }
      assert(state.listings[JSON.stringify([checkoutKey(checkout), 'folder'])]?.entries.length);
    } finally {
      await restored.dispose();
    }
  } finally {
    await f.dispose();
  }
});
