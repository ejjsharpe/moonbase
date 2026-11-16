import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EditorController, EditorMutation, ReplacePrompt } from '@moonbase/application/editor';
import { checkout, fixture, target } from './editor-fixture.ts';

/**
 * The fixture's editor with each mutation its `runMutation` creates counted as it is disposed, and
 * each replace prompt recorded in `asked` and answered with `reply` (left pending while null), so
 * an unexpected prompt fails a test instead of hanging it.
 */
async function counted() {
  const f = await fixture();
  const replies = { reply: false as boolean | null, asked: [] as string[][] };
  const seen = new Set<string>();
  f.editor.subscribe(() => {
    const prompt = f.editor.getSnapshot().replacePrompt;
    if (!prompt || seen.has(prompt.id)) return;
    seen.add(prompt.id);
    replies.asked.push(prompt.paths);
    const reply = replies.reply;
    if (reply !== null) queueMicrotask(() => f.editor.answerReplace(prompt.id, reply));
  });
  const disposals: number[] = [];
  const createMutation = f.editor.createMutation.bind(f.editor);
  f.editor.createMutation = (action): EditorMutation => {
    const mutation = createMutation(action),
      index = disposals.push(0) - 1,
      dispose = mutation.dispose.bind(mutation);
    mutation.dispose = () => {
      disposals[index]++;
      return dispose();
    };
    return mutation;
  };
  const read = async (path: string) => (await f.client.command('readFile', target(path))).text;
  return Object.assign(replies, { ...f, disposals, read });
}

/** Resolves with the next replace prompt `editor` publishes. */
function nextPrompt(editor: EditorController) {
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
      await f.editor.runMutation({ checkout, kind: 'move', paths: ['a.ts'] }, 'moved.ts'),
      done(['a.ts', 'moved.ts']),
    );
    assert.equal(await f.read('moved.ts'), 'const a = 1;');
    assert.deepEqual(f.asked, []);
    assert.deepEqual(f.disposals, [1]);
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
      f.editor.runMutation({ checkout, kind: 'move', paths }, destination);
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
    assert.deepEqual(f.disposals, [1, 1]);
  } finally {
    await f.dispose();
  }
});

test('a direct mutation asks before replacing and applies only with consent', async () => {
  const f = await counted();
  try {
    const copy = { checkout, kind: 'copy' as const, paths: ['a.ts'] };
    assert.deepEqual(await f.editor.runMutation(copy, 'b.ts'), declined);
    assert.equal(await f.read('b.ts'), 'second');
    f.reply = true;
    assert.deepEqual(await f.editor.runMutation(copy, 'b.ts'), done(['a.ts', 'b.ts']));
    assert.equal(await f.read('b.ts'), 'const a = 1;');
    assert.deepEqual(f.asked, [['b.ts'], ['b.ts']]);
    assert.equal(f.editor.getSnapshot().replacePrompt, null);
    assert.equal(f.editor.getSnapshot().mutating, false);
    assert.deepEqual(f.disposals, [1, 1]);
  } finally {
    await f.dispose();
  }
});

test('a direct mutation returns its failure instead of throwing', async () => {
  const f = await counted();
  try {
    const result = await f.editor.runMutation(
      { checkout, kind: 'create-file', paths: [] },
      'missing/new.ts',
    );
    assert.equal(result.completed, false);
    assert.notEqual(result.error, '');
    assert.deepEqual(f.disposals, [1]);
    // A checkout that isn't open is refused before anything is created.
    const closed = { ...checkout, checkoutId: 'closed', root: '/memory/closed' };
    assert.deepEqual(
      await f.editor.runMutation({ checkout: closed, kind: 'create-file', paths: [] }, 'new.ts'),
      unavailable,
    );
    assert.deepEqual(f.disposals, [1]);
  } finally {
    await f.dispose();
  }
});

test('one direct mutation runs at a time; another is refused until it ends', async () => {
  const f = await counted();
  try {
    f.reply = null;
    const copy = { checkout, kind: 'copy' as const, paths: ['a.ts'] };
    const running = f.editor.runMutation(copy, 'b.ts');
    assert.equal(f.editor.getSnapshot().mutating, true);
    assert.equal(f.editor.canMutate(copy), false);
    const prompt = await nextPrompt(f.editor);
    assert.deepEqual(prompt.paths, ['b.ts']);
    assert.deepEqual(await f.editor.runMutation(copy, 'other.ts'), unavailable);
    f.editor.answerReplace(prompt.id, false);
    assert.deepEqual(await running, declined);
    assert.equal(f.editor.canMutate(copy), true);
    assert.deepEqual(f.disposals, [1]);
  } finally {
    await f.dispose();
  }
});

test('disposing the editor while it asks declines the mutation and disposes it once', async () => {
  const f = await counted();
  try {
    f.reply = null;
    const running = f.editor.runMutation({ checkout, kind: 'copy', paths: ['a.ts'] }, 'b.ts');
    await nextPrompt(f.editor);
    await f.editor.dispose();
    assert.deepEqual(await running, declined);
    assert.equal(await f.read('b.ts'), 'second');
    assert.deepEqual(f.disposals, [1]);
  } finally {
    await f.dispose();
  }
});

test('a move may change only its name’s case, and a copy onto its source is refused', async () => {
  const f = await counted();
  try {
    assert.deepEqual(
      await f.editor.runMutation({ checkout, kind: 'move', paths: ['a.ts'] }, 'A.ts'),
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
        await f.editor.runMutation({ checkout, kind: 'copy', paths: ['b.ts'] }, destination),
        { completed: false, error: 'Choose a different name from the original.', items: [] },
      );
    assert.equal(await f.read('b.ts'), 'second');
    assert.deepEqual(f.disposals, [1, 1, 1]);
  } finally {
    await f.dispose();
  }
});

test('a batch import with known names asks before replacing what they would land on', async () => {
  const f = await counted();
  try {
    const dispatched: Parameters<typeof f.editor.mutate>[0][] = [];
    // The faux workspace has no native file authority; record what would be imported.
    f.editor.mutate = async (input) => {
      dispatched.push(structuredClone(input));
      return {
        id: input.id!,
        clientId: 'editor-one',
        checkout: input.checkout,
        kind: input.kind,
        outcome: 'completed',
        recoveryChanges: [],
        items: [],
      };
    };
    const action = {
      checkout,
      kind: 'import' as const,
      paths: [],
      nativeReferences: ['one', 'two'],
      // Names match as the workspace folds them.
      nativeNames: ['NESTED.ts', 'new.ts'],
    };
    assert.deepEqual(await f.editor.runMutation(action, 'folder'), declined);
    assert.equal(dispatched.length, 0);
    f.reply = true;
    const result = await f.editor.runMutation(action, 'folder');
    assert.equal(result.completed, true);
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
      (await f.editor.runMutation({ ...action, nativeNames: ['x.ts', 'y.ts'] }, '')).completed,
      true,
    );
    assert.deepEqual(dispatched[1].replacements, []);
    // Names that don't match the references are refused before anything is dispatched.
    assert.deepEqual(await f.editor.runMutation({ ...action, nativeNames: ['only.ts'] }, ''), {
      completed: false,
      error: 'Imported names don’t match the selection.',
      items: [],
    });
    assert.equal(dispatched.length, 2);
    assert.deepEqual(f.asked, [['folder/nested.ts'], ['folder/nested.ts']]);
    assert.deepEqual(f.disposals, [1, 1, 1, 1]);
  } finally {
    await f.dispose();
  }
});
