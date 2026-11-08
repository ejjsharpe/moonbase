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

test('a direct mutation completes without consent when nothing is replaced', async () => {
  const f = await counted();
  try {
    assert.deepEqual(
      await runMutation(f.controller, { checkout, kind: 'move', paths: ['a.ts'] }, 'moved.ts', {
        confirmReplace: never,
      }),
      { completed: true, error: '' },
    );
    assert.equal(await f.read('moved.ts'), 'const a = 1;');
    assert.deepEqual(f.disposals, [1]);
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
      { completed: false, error: '' },
    );
    assert.equal(await f.read('b.ts'), 'second');
    assert.deepEqual(
      await runMutation(f.controller, copy, 'b.ts', { confirmReplace: confirm(true) }),
      { completed: true, error: '' },
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
    assert.deepEqual(result, { completed: false, error: '' });
    assert.equal(await f.read('b.ts'), 'second');
    assert.deepEqual(f.disposals, [1]);
    // An aborted signal creates nothing.
    assert.deepEqual(
      await runMutation(f.controller, { checkout, kind: 'move', paths: ['a.ts'] }, 'x.ts', {
        signal: abort.signal,
        confirmReplace: never,
      }),
      { completed: false, error: '' },
    );
    assert.deepEqual(f.disposals, [1]);
  } finally {
    await f.dispose();
  }
});
