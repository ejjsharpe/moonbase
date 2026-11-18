import {
  acquireEditor,
  answering,
  checkout,
  second,
  target,
  fixture,
  loadStoredState,
  draftsOf,
  tabPathsOf,
} from '../editor-fixture.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import type { WorkspaceClient } from '@moonbase/application/testing/editor-fixture';

test('incompatible recovered operation evidence never rebinds equal checkout/path strings', async () => {
  const f = await fixture();
  try {
    await f.editor.open(target('a.ts'));
    f.editor.edit(target('a.ts'), 'retained');
    await f.editor.flush();
    await f.editor.dispose();
    const client: WorkspaceClient = {
      ...f.client,
      async command(name, input, options) {
        const result = await f.client.command(name, input, options);
        if (name !== 'loadRecovery') return result;
        return {
          ...result,
          operations: [
            {
              id: 'foreign',
              clientId: 'origin',
              checkout: { ...checkout, hostId: 'impostor' },
              kind: 'move',
              outcome: 'completed',
              items: [{ source: 'a.ts', destination: 'moved.ts', outcome: 'completed' }],
            },
          ],
        } as typeof result;
      },
    };
    const editor = await acquireEditor(f.runtime, { client, clientId: f.editor.clientId });
    try {
      await editor.load();
      assert.equal(editor.buffer(target('a.ts'))!.text, 'retained');
      assert.equal(editor.buffer(target('moved.ts')), undefined);
      assert.match(editor.getSnapshot().errors.join(' '), /identity unavailable or changed/);
      assert.equal(editor.getSnapshot().operations[0].checkout.hostId, 'impostor');
    } finally {
      await editor.dispose();
    }
  } finally {
    await f.dispose();
  }
});

test('dirty Copy carries a separate destination draft; Trash retains dirty source recovery', async () => {
  const f = await fixture();
  try {
    await f.editor.open(target('a.ts'));
    f.editor.edit(target('a.ts'), 'dirty copy');
    let sources = await f.editor.inspect(checkout, ['a.ts']);
    await f.editor.mutate({ checkout, sources, kind: 'copy', destination: 'copy.ts' });
    assert.equal(f.editor.buffer(target('copy.ts'))!.text, 'dirty copy');
    assert.equal(f.editor.buffer(target('copy.ts'))!.disk.text, 'const a = 1;');
    sources = await f.editor.inspect(checkout, ['a.ts']);
    await f.editor.mutate({ checkout, sources, kind: 'trash' });
    assert.equal(f.editor.buffer(target('a.ts'))!.text, 'dirty copy');
    await f.editor.flush();
    const stored = await loadStoredState(f.client, f.editor.clientId);
    assert.deepEqual(
      draftsOf(stored)
        .map((d) => [d.target.path, d.text])
        .sort(),
      [
        ['a.ts', 'dirty copy'],
        ['copy.ts', 'dirty copy'],
      ],
    );
    assert.deepEqual(tabPathsOf(stored).sort(), ['a.ts', 'copy.ts']);
  } finally {
    await f.dispose();
  }
});

test('closed checkout metadata receives operation results without discovery or reopening', async () => {
  const f = await fixture('closed-results', false);
  try {
    await f.editor.open(target('a.ts'), { view: 'staged' });
    await f.editor.openCheckout(second.root);
    await answering(
      f.editor,
      () => f.editor.closeCheckout(checkout),
      async () => 'discard',
    );
    const sources = await f.client.command('inspectEntries', { checkout, paths: ['a.ts'] });
    await f.client.command('mutate', {
      id: 'closed-move',
      clientId: 'foreign',
      checkout,
      kind: 'move',
      sources,
      destination: 'moved.ts',
    });
    await f.editor.dispose();
    const observed: string[] = [];
    const restored = await acquireEditor(f.runtime, {
      clientId: 'closed-results',
      client: {
        ...f.client,
        watch(input, receive, error) {
          observed.push('watch:' + input.checkout.checkoutId);
          return f.client.watch(input, receive, error);
        },
        command(name, input, options) {
          if (['readFile', 'listDirectory', 'gitStatus', 'readComparison'].includes(name)) {
            const scoped = input as {
              checkout?: CheckoutTarget;
              target?: { checkout: CheckoutTarget };
            };
            observed.push(name + ':' + (scoped.checkout ?? scoped.target?.checkout)?.checkoutId);
          }
          return f.client.command(name, input, options);
        },
      },
    });
    try {
      await restored.load();
      const state = restored.getSnapshot();
      const closed = state.recovery.views.get(checkout.checkoutId)!;
      assert.equal(closed.fileViews.get('moved.ts'), 'staged');
      assert.equal(closed.fileViews.get('a.ts'), undefined);
      assert.deepEqual(state.recovery.openCheckoutIds, [second.checkoutId]);
      assert(observed.length);
      assert.equal(
        observed.some((value) => value.endsWith(':' + checkout.checkoutId)),
        false,
      );
      assert.equal(
        (await f.client.command('loadRecovery', { clientId: restored.clientId })).operations.length,
        0,
      );
    } finally {
      await restored.dispose();
    }
  } finally {
    await f.dispose();
  }
});
