import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkoutKey, fileKey } from '@moonbase/application/editor';
import { acquireEditor, answering } from './editor-model-fixture.ts';
import { checkout, second, target, fixture } from './editor-fixture.ts';

test('snapshot consumers cannot mutate buffers, recovery, comparisons or discovery in later publications', async () => {
  const f = await fixture('snapshots', false);
  try {
    await f.editor.open(target('a.ts'), { view: 'unstaged', intent: 'keep' });
    await f.editor.open(target('b.ts'), { intent: 'keep' });
    await f.editor.flush();
    const snapshot = f.editor.getSnapshot();
    const expected = structuredClone(snapshot);
    assert.equal(f.editor.getSnapshot(), snapshot);

    snapshot.buffers[0].text = 'consumer text';
    snapshot.buffers[0].disk.text = 'consumer disk';
    snapshot.buffers[0].target.checkout.root = '/consumer';
    snapshot.buffers[0].target.path = 'consumer.ts';
    snapshot.recovery.checkouts[0].branch = 'consumer';
    snapshot.recovery.views[checkout.checkoutId].openFiles.push('consumer.ts');
    snapshot.recovery.views[checkout.checkoutId].fileViews['a.ts'] = 'file';
    snapshot.recovery.views[checkout.checkoutId].tree.expanded.push('consumer');
    snapshot.comparisons[fileKey(target('a.ts'))].working!.text = 'consumer comparison';
    snapshot.listings[fileKey(target(''))].entries[0].path = 'consumer listing';
    snapshot.git[checkoutKey(checkout)].changes[0].path = 'consumer Git';

    f.editor.clearErrors();
    const next = f.editor.getSnapshot();
    assert.notEqual(next, snapshot);
    assert.deepEqual(next, expected);
    assert.equal(f.editor.getSnapshot(), next);
    f.editor.edit(target('a.ts'), 'valid edit');
    assert.equal(await f.editor.save(target('a.ts')), true);
    assert.equal((await f.client.command('readFile', target('a.ts'))).text, 'valid edit');
  } finally {
    await f.dispose();
  }
});

test('retained snapshots stay stable across edits, positions, disk/conflict updates and close prompts', async () => {
  const f = await fixture('snapshot-updates', false);
  const retained: { snapshot: ReturnType<typeof f.editor.getSnapshot>; expected: unknown }[] = [];
  const retain = () => {
    const snapshot = f.editor.getSnapshot();
    retained.push({ snapshot, expected: structuredClone(snapshot) });
    return snapshot;
  };
  try {
    await f.editor.open(target('a.ts'), { intent: 'keep' });
    await f.editor.openCheckout(second.root);
    await f.editor.open(target('b.ts', second), { intent: 'keep' });
    const initial = retain();
    f.memory.externalWrite(target('a.ts'), 'new disk');
    await f.editor.open(target('a.ts'), { intent: 'keep' });
    assert.notEqual(f.editor.getSnapshot(), initial);
    assert.equal(f.editor.buffer(target('a.ts'))!.disk.text, 'new disk');
    retain();
    f.editor.edit(target('a.ts'), 'draft');
    assert.equal(f.editor.getSnapshot().recoveryReady, false);
    retain();
    f.editor.position(target('a.ts'), 'file', { line: 2, column: 3, top: 4, left: 5 });
    assert.equal(
      f.editor.getSnapshot().recovery.views[checkout.checkoutId].positions['a.ts'].file!.line,
      2,
    );
    retain();
    f.memory.externalWrite(target('a.ts'), 'conflicting disk');
    assert.equal(await f.editor.save(target('a.ts')), false);
    assert.equal(f.editor.buffer(target('a.ts'))!.conflict!.text, 'conflicting disk');
    retain();
    f.editor.cancelConflict(target('a.ts'));
    assert.equal(f.editor.buffer(target('a.ts'))!.conflict, undefined);
    await f.editor.open(target('a.ts'), { view: 'conflict' });
    retain();
    assert.equal(await f.editor.save(target('a.ts'), true), true);
    assert.equal(f.editor.buffer(target('a.ts'))!.disk.text, 'draft');
    retain();
    f.editor.edit(target('a.ts'), 'another draft');
    assert.equal(
      await answering(
        f.editor,
        () => f.editor.close([target('a.ts')]),
        async () => {
          const prompt = f.editor.getSnapshot().closePrompt!;
          prompt.buffer.disk.text = 'consumer prompt disk';
          prompt.buffer.target.path = 'consumer prompt target';
          f.editor.clearErrors();
          retain();
          return 'cancel';
        },
      ),
      false,
    );
    const prompt = retained.at(-1)!.snapshot.closePrompt!;
    assert.equal(prompt.buffer.disk.text, 'draft');
    assert.equal(prompt.buffer.target.path, 'a.ts');
    assert.equal(f.editor.buffer(target('b.ts', second))!.text, 'second');
    for (const { snapshot, expected } of retained) assert.deepEqual(snapshot, expected);
    await f.editor.flush();
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
  } finally {
    await f.dispose();
  }
});

test('restored drafts and uncertain Save/move facts remain isolated and update exact identities', async () => {
  const f = await fixture('snapshot-recovery', false);
  let editor = f.editor;
  try {
    await editor.open(target('a.ts'), { intent: 'keep' });
    await editor.open(target('b.ts'), { intent: 'keep' });
    editor.edit(target('a.ts'), 'restored a');
    editor.edit(target('b.ts'), 'restored b');
    await editor.flush();
    await editor.dispose();
    editor = await acquireEditor(f.runtime, {
      client: { ...f.client, watch: () => async () => {} },
      clientId: editor.clientId,
    });
    await editor.load();
    const restored = editor.getSnapshot();
    const expected = structuredClone(restored);
    editor.edit(target('a.ts'), 'captured save');
    f.memory.failNext('saveFile', 'Lost Save response', true);
    await assert.rejects(editor.save(target('a.ts')), /Lost Save response/);
    const pending = editor.buffer(target('a.ts'))!.pendingSave!;
    const savedRequest = structuredClone(pending);
    pending.text = 'consumer request';
    pending.target.checkout.root = '/consumer';
    pending.requestId = 'consumer-request';
    restored.recovery.drafts[0].text = 'consumer restored draft';
    restored.recovery.drafts[0].disk.version = 'consumer version';
    restored.recovery.drafts[0].target.path = 'consumer.ts';
    editor.edit(target('a.ts'), 'newer live a');
    assert.deepEqual(editor.buffer(target('a.ts'))!.pendingSave, savedRequest);
    assert.deepEqual(editor.getSnapshot().recovery.drafts, expected.recovery.drafts);
    assert.equal(await editor.save(target('a.ts')), false);
    assert.equal(editor.buffer(target('a.ts'))!.text, 'newer live a');
    assert.equal(editor.buffer(target('a.ts'))!.disk.text, 'captured save');

    const beforeMove = editor.getSnapshot();
    const expectedMove = structuredClone(beforeMove);
    f.memory.failNext('mutate', 'Lost move response', true);
    await assert.rejects(
      editor.mutate({
        id: 'snapshot-move',
        checkout,
        kind: 'move',
        sources: await editor.inspect(checkout, ['a.ts']),
        destination: 'moved.ts',
      }),
      /Lost move response/,
    );
    const operation = editor.getSnapshot().operations[0];
    operation.checkout.root = '/consumer';
    operation.items.push({ source: 'a.ts', destination: 'consumer.ts', outcome: 'completed' });
    operation.id = 'consumer-operation';
    await editor.resolveOperation('snapshot-move');
    assert.equal(editor.buffer(target('a.ts')), undefined);
    assert.equal(editor.buffer(target('moved.ts'))!.text, 'newer live a');
    assert.equal(editor.buffer(target('moved.ts'))!.disk.text, 'captured save');
    assert.equal(editor.buffer(target('b.ts'))!.text, 'restored b');
    assert.deepEqual(beforeMove, expectedMove);
    assert.equal(f.memory.stats.saves, 1);
    assert.equal(f.memory.stats.mutations, 1);
    await editor.flush();
    assert.equal(editor.getSnapshot().recoveryReady, true);
    const state = (await f.client.command('loadRecovery', { clientId: editor.clientId })).state;
    assert.equal(
      state.drafts.find((draft) => draft.target.path === 'moved.ts')!.text,
      'newer live a',
    );
  } finally {
    await editor.dispose();
    await f.dispose();
  }
});
