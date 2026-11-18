import { acquireEditor, answering } from '../editor-fixture.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ManagedRuntime } from 'effect';
import { toWorkspaceClient as makeEditorClient } from '@moonbase/application/testing/editor-fixture';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';

const checkout = {
  hostId: 'local',
  checkoutId: 'filenames',
  projectId: 'project',
  root: '/memory/filenames',
  vcs: 'git' as const,
  branch: 'main',
  worktree: 'main' as 'main' | 'linked',
};

const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];

const target = (path: string) => ({ checkout, path });

const cursor = { line: 1, column: 3, top: 0, left: 0 };

function protectPrototypes() {
  const objects = [
    Object.prototype,
    Object,
    Object.prototype.toString,
    Object.prototype.hasOwnProperty,
  ];
  const snapshots = objects.map((value) => Object.getOwnPropertyDescriptors(value));
  return {
    assertUnchanged() {
      objects.forEach((value, index) =>
        assert.deepEqual(Object.getOwnPropertyDescriptors(value), snapshots[index]),
      );
    },
    restore() {
      objects.forEach((value, index) => {
        for (const key of Reflect.ownKeys(value))
          if (!Object.hasOwn(snapshots[index], key)) Reflect.deleteProperty(value, key);
        Object.defineProperties(value, snapshots[index]);
      });
    },
  };
}

test('filename caret state never mutates inherited prototypes', async () => {
  const prototypes = protectPrototypes();
  const memory = fauxWorkspace([
    { checkout, files: Object.fromEntries([['__proto__', 'baseline']]) },
  ]);
  const runtime = ManagedRuntime.make(memory.layer),
    editor = await acquireEditor(runtime, {
      client: makeEditorClient(runtime),
      clientId: 'prototype',
    });
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    await editor.open(target('__proto__'), { view: 'file' });
    editor.position(target('__proto__'), 'file', cursor);
    prototypes.assertUnchanged();
    const view = editor.getSnapshot().recovery.views.get(checkout.checkoutId)!;
    assert(view.fileViews.has('__proto__'));
    assert.deepEqual(view.positions.get('__proto__')?.file, cursor);
  } finally {
    prototypes.restore();
    await editor.dispose();
    await runtime.dispose();
  }
});

test('prototype-shaped filenames keep own JSON view keys through Save, reopen, restart and move reconciliation', async () => {
  const prototypes = protectPrototypes(),
    files = Object.fromEntries(['sibling.ts', ...names].map((path) => [path, 'baseline ' + path]));
  const memory = fauxWorkspace([{ checkout, files, head: files, index: files }]);
  const runtime = ManagedRuntime.make(memory.layer),
    client = makeEditorClient(runtime);
  let editor = await acquireEditor(runtime, { client, clientId: 'filenames' });
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    await editor.open(target('sibling.ts'));
    editor.edit(target('sibling.ts'), 'retained sibling');
    for (const path of names) {
      assert.equal(await editor.open(target(path)), true);
      editor.edit(target(path), 'saved ' + path);
      assert.equal(await editor.save(target(path)), true);
      assert.equal((await client.command('readFile', target(path))).text, 'saved ' + path);
      await editor.open(target(path), { view: 'staged' });
      editor.position(target(path), 'staged', cursor);
      editor.position(target(path), 'staged:original', cursor);
      editor.edit(target(path), 'newer dirty ' + path);
    }
    await editor.flush();
    const persisted = (await client.command('loadRecovery', { clientId: 'filenames' })).state;
    const json = JSON.parse(JSON.stringify(persisted)),
      view = json.views[checkout.checkoutId];
    for (const path of names) {
      const id = persisted.buffers.find((buffer) => buffer.target.path === path)!.id;
      assert(Object.hasOwn(view.fileViews, id));
      assert(Object.hasOwn(view.positions, id));
    }
    await editor.dispose();
    editor = await acquireEditor(runtime, { client, clientId: 'filenames' });
    await editor.load();
    for (const path of names) {
      assert.equal(await editor.open(target(path)), true);
      assert.equal(editor.buffer(target(path))?.text, 'newer dirty ' + path);
      assert.equal(editor.buffer(target(path))?.disk.text, 'saved ' + path);
      assert.deepEqual(
        editor.getSnapshot().recovery.views.get(checkout.checkoutId)!.positions.get(path)?.staged,
        cursor,
      );
      assert.equal(
        await answering(
          editor,
          () => editor.close([target(path)]),
          async () => 'save',
        ),
        true,
      );
      assert.equal(await editor.reopen(checkout), true);
      assert.equal(
        editor.getSnapshot().recovery.views.get(checkout.checkoutId)!.fileViews.get(path),
        'staged',
      );
    }
    assert.equal(editor.buffer(target('sibling.ts'))?.text, 'retained sibling');
    const source = target('__proto__');
    editor.edit(source, 'dirty moved text');
    await editor.mutate({
      checkout,
      kind: 'move',
      sources: await editor.inspect(checkout, [source.path]),
      destination: 'moved.ts',
    });
    await editor.mutate({
      checkout,
      kind: 'move',
      sources: await editor.inspect(checkout, ['moved.ts']),
      destination: '__proto__',
    });
    await editor.flush();
    await editor.dispose();
    editor = await acquireEditor(runtime, { client, clientId: 'filenames' });
    await editor.load();
    assert.equal(editor.buffer(source)?.text, 'dirty moved text');
    assert.deepEqual(
      editor.getSnapshot().recovery.views.get(checkout.checkoutId)!.positions.get('__proto__')
        ?.staged,
      cursor,
    );
    for (const [from, destination] of [
      ['__proto__', 'foreign.ts'],
      ['foreign.ts', '__proto__'],
    ]) {
      await client.command('mutate', {
        checkout,
        clientId: 'foreign',
        id: crypto.randomUUID(),
        kind: 'move',
        sources: await client.command('inspectEntries', { checkout, paths: [from] }),
        destination,
      });
      await editor.reconcileRecovery();
    }
    await editor.flush();
    assert.equal(editor.buffer(source)?.text, 'dirty moved text');
    assert.equal(memory.stats.mutations, 4);
    assert(
      editor.getSnapshot().recovery.views.get(checkout.checkoutId)!.positions.has('__proto__'),
    );
    prototypes.assertUnchanged();
  } finally {
    prototypes.restore();
    await editor.dispose();
    await runtime.dispose();
  }
});
