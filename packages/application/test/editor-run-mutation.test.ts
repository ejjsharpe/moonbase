import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EntryReference } from '@moonbase/contracts/workspace';
import { runMutation, type EditorMutation } from '@moonbase/application/editor';
import { checkout, fixture, target } from './editor-fixture.ts';

/** The fixture's editor with each mutation's disposal counted. */
async function counted() {
  const f = await fixture();
  const disposals: number[] = [];
  const createMutation = f.editor.createMutation.bind(f.editor);
  const controller = {
    report: f.editor.report,
    createMutation(action: Parameters<typeof createMutation>[0]): EditorMutation {
      const mutation = createMutation(action),
        index = disposals.push(0) - 1,
        dispose = mutation.dispose.bind(mutation);
      mutation.dispose = () => {
        disposals[index]++;
        return dispose();
      };
      return mutation;
    },
  };
  const read = async (path: string) => (await f.client.command('readFile', target(path))).text;
  return { ...f, controller, disposals, read };
}

const never = () => Promise.reject(new Error('No replacement was expected'));
/** A completed result, moving or copying each `[source, destination]`. */
const done = (...pairs: [string, string][]) => ({
  completed: true,
  error: '',
  items: pairs.map(([source, destination]) => ({ source, destination, outcome: 'completed' })),
});
const declined = { completed: false, error: '', items: [] };

test('a direct mutation completes without consent when nothing is replaced', async () => {
  const f = await counted();
  try {
    assert.deepEqual(
      await runMutation(f.controller, { checkout, kind: 'move', paths: ['a.ts'] }, 'moved.ts', {
        confirmReplace: never,
      }),
      done(['a.ts', 'moved.ts']),
    );
    assert.equal(await f.read('moved.ts'), 'const a = 1;');
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
      runMutation(f.controller, { checkout, kind: 'move', paths }, destination, {
        confirmReplace: never,
      });
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
    const asked: string[][] = [];
    const confirm = (answer: boolean) => async (replacements: EntryReference[]) => {
      asked.push(replacements.map((item) => item.target.path));
      return answer;
    };
    const copy = { checkout, kind: 'copy' as const, paths: ['a.ts'] };
    assert.deepEqual(
      await runMutation(f.controller, copy, 'b.ts', { confirmReplace: confirm(false) }),
      declined,
    );
    assert.equal(await f.read('b.ts'), 'second');
    assert.deepEqual(
      await runMutation(f.controller, copy, 'b.ts', { confirmReplace: confirm(true) }),
      done(['a.ts', 'b.ts']),
    );
    assert.equal(await f.read('b.ts'), 'const a = 1;');
    assert.deepEqual(asked, [['b.ts'], ['b.ts']]);
    assert.deepEqual(f.disposals, [1, 1]);
  } finally {
    await f.dispose();
  }
});

test('a direct mutation returns its failure instead of throwing', async () => {
  const f = await counted();
  try {
    const result = await runMutation(
      f.controller,
      { checkout, kind: 'create-file', paths: [] },
      'missing/new.ts',
      { confirmReplace: never },
    );
    assert.equal(result.completed, false);
    assert.notEqual(result.error, '');
    assert.deepEqual(f.disposals, [1]);
    // A refused acquisition fails the same way, with nothing to dispose.
    const closed = { ...checkout, checkoutId: 'closed', root: '/memory/closed' };
    const refused = await runMutation(
      f.controller,
      { checkout: closed, kind: 'create-file', paths: [] },
      'new.ts',
      { confirmReplace: never },
    );
    assert.equal(refused.completed, false);
    assert.notEqual(refused.error, '');
    assert.deepEqual(f.disposals, [1]);
  } finally {
    await f.dispose();
  }
});

test('aborting a direct mutation while it asks declines it and disposes it', async () => {
  const f = await counted();
  try {
    const abort = new AbortController();
    const result = await runMutation(
      f.controller,
      { checkout, kind: 'copy', paths: ['a.ts'] },
      'b.ts',
      {
        signal: abort.signal,
        confirmReplace: async () => {
          abort.abort();
          assert.deepEqual(f.disposals, [1]);
          return true;
        },
      },
    );
    assert.deepEqual(result, declined);
    assert.equal(await f.read('b.ts'), 'second');
    assert.deepEqual(f.disposals, [1]);
    // An aborted signal creates nothing.
    assert.deepEqual(
      await runMutation(f.controller, { checkout, kind: 'move', paths: ['a.ts'] }, 'x.ts', {
        signal: abort.signal,
        confirmReplace: never,
      }),
      declined,
    );
    assert.deepEqual(f.disposals, [1]);
  } finally {
    await f.dispose();
  }
});

test('a rejected confirmation returns its error instead of throwing', async () => {
  const f = await counted();
  try {
    const result = await runMutation(
      f.controller,
      { checkout, kind: 'copy', paths: ['a.ts'] },
      'b.ts',
      { confirmReplace: () => Promise.reject(new Error('Prompt unavailable')) },
    );
    assert.equal(result.completed, false);
    assert.notEqual(result.error, '');
    assert.equal(await f.read('b.ts'), 'second');
    assert.deepEqual(f.disposals, [1]);
  } finally {
    await f.dispose();
  }
});

test('aborting while a confirmation is unanswered resolves at once and disposes once', async () => {
  const f = await counted();
  try {
    const abort = new AbortController();
    let asked!: () => void;
    const asking = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const running = runMutation(f.controller, { checkout, kind: 'copy', paths: ['a.ts'] }, 'b.ts', {
      signal: abort.signal,
      confirmReplace: () => {
        asked();
        return new Promise<boolean>(() => {});
      },
    });
    await asking;
    abort.abort();
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
      await runMutation(f.controller, { checkout, kind: 'move', paths: ['a.ts'] }, 'A.ts', {
        confirmReplace: never,
      }),
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
        await runMutation(f.controller, { checkout, kind: 'copy', paths: ['b.ts'] }, destination, {
          confirmReplace: never,
        }),
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
    // The memory workspace has no native file authority; record what would be imported.
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
    const asked: string[][] = [];
    const confirm = (answer: boolean) => async (replacements: EntryReference[]) => {
      asked.push(replacements.map((item) => item.target.path));
      return answer;
    };
    const action = {
      checkout,
      kind: 'import' as const,
      paths: [],
      nativeReferences: ['one', 'two'],
      // Names match as the workspace folds them.
      nativeNames: ['NESTED.ts', 'new.ts'],
    };
    assert.deepEqual(
      await runMutation(f.controller, action, 'folder', { confirmReplace: confirm(false) }),
      declined,
    );
    assert.equal(dispatched.length, 0);
    const result = await runMutation(f.controller, action, 'folder', {
      confirmReplace: confirm(true),
    });
    assert.equal(result.completed, true);
    assert.deepEqual(asked, [['folder/nested.ts'], ['folder/nested.ts']]);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].destination, 'folder');
    assert.deepEqual(dispatched[0].nativeReferences, ['one', 'two']);
    assert.deepEqual(
      dispatched[0].replacements?.map((item) => item.target.path),
      ['folder/nested.ts'],
    );
    // Into the root with nothing in the way, it imports without asking.
    assert.equal(
      (
        await runMutation(f.controller, { ...action, nativeNames: ['x.ts', 'y.ts'] }, '', {
          confirmReplace: never,
        })
      ).completed,
      true,
    );
    assert.deepEqual(dispatched[1].replacements, []);
    // Names that don't match the references are refused before anything is dispatched.
    assert.deepEqual(
      await runMutation(f.controller, { ...action, nativeNames: ['only.ts'] }, '', {
        confirmReplace: never,
      }),
      { completed: false, error: 'Imported names don’t match the selection.', items: [] },
    );
    assert.equal(dispatched.length, 2);
    assert.deepEqual(f.disposals, [1, 1, 1, 1]);
  } finally {
    await f.dispose();
  }
});
