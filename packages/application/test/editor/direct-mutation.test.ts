import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReplacePrompt } from '@moonbase/application/editor';
import type { EditorDriver } from './editor-model-fixture.ts';
import type { WorkspaceOperation } from '@moonbase/contracts/workspace';
import type { WorkspaceClient } from '@moonbase/application/testing/editor-fixture';
import { acquireEditor } from './editor-model-fixture.ts';
import { checkout, fixture, target } from './editor-fixture.ts';

/**
 * The fixture's editor (over `wrap`'s client, if given) with each replace prompt recorded in
 * `asked` and answered with `reply` (left pending while null), so an unexpected prompt fails a
 * test instead of hanging it.
 */
async function counted(wrap?: (client: WorkspaceClient) => WorkspaceClient) {
  const fixed = await fixture();
  let f = fixed;
  if (wrap) {
    await fixed.editor.dispose();
    const editor = await acquireEditor(fixed.runtime, {
      client: wrap(fixed.client),
      clientId: fixed.editor.clientId,
    });
    await editor.load();
    await editor.openCheckout(checkout.root);
    f = { ...fixed, editor, dispose: () => editor.dispose().then(fixed.dispose) };
  }
  const replies = { reply: false as boolean | null, asked: [] as string[][] };
  const seen = new Set<string>();
  f.editor.subscribe(() => {
    const prompt = f.editor.getSnapshot().replacePrompt;
    if (!prompt || seen.has(prompt.id)) return;
    seen.add(prompt.id);
    replies.asked.push(prompt.paths);
    const reply = replies.reply;
    if (reply !== null) queueMicrotask(() => f.editor.mutations.answer(prompt.id, reply));
  });
  const read = async (path: string) => (await f.client.command('readFile', target(path))).text;
  return Object.assign(replies, { ...f, read });
}

/** Resolves with the next replace prompt `editor` publishes. */
function nextPrompt(editor: EditorDriver) {
  return new Promise<ReplacePrompt>((resolve) => {
    const check = () => {
      const prompt = editor.getSnapshot().replacePrompt;
      if (!prompt) return;
      off();
      resolve(prompt);
    };
    const off = editor.subscribe(check);
    check();
  });
}

/** A completed result, moving or copying each `[source, destination]`. */
const done = (...pairs: [string, string][]) => ({
  completed: true,
  error: '',
  items: pairs.map(([source, destination]) => ({ source, destination, outcome: 'completed' })),
});
const declined = { completed: false, error: '', items: [] };
const unavailable = {
  completed: false,
  error:
    'File action unavailable. Check the selection and finish the current editor dialog or preservation.',
  items: [],
};

test('a direct mutation completes without consent when nothing is replaced', async () => {
  const f = await counted();
  try {
    assert.deepEqual(
      await f.editor.mutations.run({ checkout, kind: 'move', paths: ['a.ts'] }, 'moved.ts'),
      done(['a.ts', 'moved.ts']),
    );
    assert.equal(await f.read('moved.ts'), 'const a = 1;');
    assert.deepEqual(f.asked, []);
  } finally {
    await f.dispose();
  }
});

test('several entries move into a folder and back to the root as one batch each', async () => {
  const f = await counted();
  try {
    await f.editor.open(target('a.ts'));
    f.editor.edit(target('a.ts'), 'unsaved');
    const move = (paths: string[], destination: string) =>
      f.editor.mutations.run({ checkout, kind: 'move', paths }, destination);
    assert.deepEqual(
      await move(['a.ts', 'c.ts'], 'folder'),
      done(['a.ts', 'folder/a.ts'], ['c.ts', 'folder/c.ts']),
    );
    assert.equal(await f.read('folder/c.ts'), 'third');
    assert.equal(f.editor.buffer(target('folder/a.ts'))?.text, 'unsaved');
    assert.deepEqual(
      await move(['folder/a.ts', 'folder/c.ts'], ''),
      done(['folder/a.ts', 'a.ts'], ['folder/c.ts', 'c.ts']),
    );
    assert.equal(await f.read('a.ts'), 'const a = 1;');
    assert.equal(await f.read('c.ts'), 'third');
    assert.equal(f.editor.buffer(target('a.ts'))?.text, 'unsaved');
    assert.equal(f.editor.buffer(target('folder/a.ts')), undefined);
  } finally {
    await f.dispose();
  }
});

test('a direct mutation asks before replacing and applies only with consent', async () => {
  const f = await counted();
  try {
    const copy = { checkout, kind: 'copy' as const, paths: ['a.ts'] };
    assert.deepEqual(await f.editor.mutations.run(copy, 'b.ts'), declined);
    assert.equal(await f.read('b.ts'), 'second');
    f.reply = true;
    assert.deepEqual(await f.editor.mutations.run(copy, 'b.ts'), done(['a.ts', 'b.ts']));
    assert.equal(await f.read('b.ts'), 'const a = 1;');
    assert.deepEqual(f.asked, [['b.ts'], ['b.ts']]);
    assert.equal(f.editor.getSnapshot().replacePrompt, null);
    assert.equal(f.editor.getSnapshot().mutating, false);
  } finally {
    await f.dispose();
  }
});

test('a direct mutation returns its failure instead of throwing', async () => {
  const f = await counted();
  try {
    const result = await f.editor.mutations.run(
      { checkout, kind: 'create-file', paths: [] },
      'missing/new.ts',
    );
    assert.equal(result.completed, false);
    assert.notEqual(result.error, '');
    // A checkout that isn't open is refused before anything is created.
    const closed = { ...checkout, checkoutId: 'closed', root: '/memory/closed' };
    assert.deepEqual(
      await f.editor.mutations.run({ checkout: closed, kind: 'create-file', paths: [] }, 'new.ts'),
      unavailable,
    );
  } finally {
    await f.dispose();
  }
});

test('one direct mutation runs at a time; another is refused until it ends', async () => {
  const f = await counted();
  try {
    f.reply = null;
    const copy = { checkout, kind: 'copy' as const, paths: ['a.ts'] };
    const running = f.editor.mutations.run(copy, 'b.ts');
    assert.equal(f.editor.getSnapshot().mutating, true);
    assert.equal(f.editor.mutations.admits(copy), false);
    const prompt = await nextPrompt(f.editor);
    assert.deepEqual(prompt.paths, ['b.ts']);
    assert.deepEqual(await f.editor.mutations.run(copy, 'other.ts'), unavailable);
    f.editor.mutations.answer(prompt.id, false);
    assert.deepEqual(await running, declined);
    assert.equal(f.editor.mutations.admits(copy), true);
  } finally {
    await f.dispose();
  }
});

test('disposing the editor while it asks declines the mutation and disposes it once', async () => {
  const f = await counted();
  try {
    f.reply = null;
    const running = f.editor.mutations.run({ checkout, kind: 'copy', paths: ['a.ts'] }, 'b.ts');
    await nextPrompt(f.editor);
    await f.editor.dispose();
    assert.deepEqual(await running, declined);
    assert.equal(await f.read('b.ts'), 'second');
  } finally {
    await f.dispose();
  }
});

test('a move may change only its name’s case, and a copy onto its source is refused', async () => {
  const f = await counted();
  try {
    assert.deepEqual(
      await f.editor.mutations.run({ checkout, kind: 'move', paths: ['a.ts'] }, 'A.ts'),
      done(['a.ts', 'A.ts']),
    );
    assert.equal(await f.read('A.ts'), 'const a = 1;');
    const listing = await f.client.command('listDirectory', { checkout, path: '' });
    assert.deepEqual(
      listing.entries.map((entry) => entry.path).filter((path) => /^a\.ts$/i.test(path)),
      ['A.ts'],
    );
    for (const destination of ['b.ts', 'B.ts'])
      assert.deepEqual(
        await f.editor.mutations.run({ checkout, kind: 'copy', paths: ['b.ts'] }, destination),
        { completed: false, error: 'Choose a different name from the original.', items: [] },
      );
    assert.equal(await f.read('b.ts'), 'second');
  } finally {
    await f.dispose();
  }
});

test('a batch import with known names asks before replacing what they would land on', async () => {
  const dispatched: WorkspaceOperation[] = [];
  // The faux workspace has no native file authority; record what would be imported.
  const f = await counted((client) => ({
    ...client,
    command: (name, input, options) => {
      // The store never journalled the recorded imports, so their acknowledgement is too.
      if (
        name === 'acknowledgeOperation' &&
        dispatched.some((operation) => operation.id === (input as { id: string }).id)
      )
        return Promise.resolve(undefined as never);
      if (name !== 'mutate' || (input as WorkspaceOperation).kind !== 'import')
        return client.command(name, input, options);
      const operation = input as WorkspaceOperation;
      dispatched.push(structuredClone(operation));
      return Promise.resolve({
        id: operation.id,
        clientId: operation.clientId,
        checkout: operation.checkout,
        kind: operation.kind,
        outcome: 'completed',
        items: [],
      } as never);
    },
  }));
  try {
    const action = {
      checkout,
      kind: 'import' as const,
      paths: [],
      nativeReferences: ['one', 'two'],
      // Names match as the workspace folds them.
      nativeNames: ['NESTED.ts', 'new.ts'],
    };
    assert.deepEqual(await f.editor.mutations.run(action, 'folder'), declined);
    assert.equal(dispatched.length, 0);
    f.reply = true;
    const result = await f.editor.mutations.run(action, 'folder');
    assert.equal(result.completed, true, result.error);
    assert.deepEqual(f.asked, [['folder/nested.ts'], ['folder/nested.ts']]);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].destination, 'folder');
    assert.deepEqual(dispatched[0].nativeReferences, ['one', 'two']);
    assert.deepEqual(
      dispatched[0].replacements?.map((item) => item.target.path),
      ['folder/nested.ts'],
    );
    // Into the root with nothing in the way, it imports without asking.
    assert.equal(
      (await f.editor.mutations.run({ ...action, nativeNames: ['x.ts', 'y.ts'] }, '')).completed,
      true,
    );
    assert.deepEqual(dispatched[1].replacements, []);
    // Names that don't match the references are refused before anything is dispatched.
    assert.deepEqual(await f.editor.mutations.run({ ...action, nativeNames: ['only.ts'] }, ''), {
      completed: false,
      error: 'Imported names don’t match the selection.',
      items: [],
    });
    assert.equal(dispatched.length, 2);
    assert.deepEqual(f.asked, [['folder/nested.ts'], ['folder/nested.ts']]);
  } finally {
    await f.dispose();
  }
});
