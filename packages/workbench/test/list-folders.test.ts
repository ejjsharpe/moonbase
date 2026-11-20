import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect } from 'effect';
import type { DirectoryEntry } from '@moonbase/contracts/workspace';
import type { EditorActions } from '../src/editor-actions.ts';
import { listFolders } from '../src/files-tree/list-folders.ts';

const checkout = { hostId: 'host', checkoutId: 'checkout' } as never;
const folder = (path: string): DirectoryEntry => ({ path, directory: true }) as DirectoryEntry;

test('each folder is listed once, and one that fails to list is gone only when its parent lists without it', async () => {
  const tree: Record<string, readonly DirectoryEntry[] | undefined> = {
    '': [folder('a')],
    a: [folder('a/kept')],
    b: undefined,
  };
  const listed: string[] = [];
  const actions = {
    list: (_checkout: unknown, path = '') =>
      Effect.sync(() => {
        listed.push(path);
        const entries = tree[path];
        return entries ? { entries } : { entries: [], error: 'unreadable' };
      }),
  } as unknown as EditorActions;
  const { listings, unlisted } = await Effect.runPromise(
    listFolders(actions, checkout, ['a/gone', 'a/kept', 'a/other', 'a', 'b/inner']),
  );
  // `a` is read once, though three folders ask about it as their parent.
  assert.deepEqual([...listed].sort(), ['', 'a', 'a/gone', 'a/kept', 'a/other', 'b', 'b/inner']);
  assert.deepEqual([...listings.keys()], ['a']);
  // `a/kept` failed while its parent still lists it, so it may be there. `a/gone` and `a/other`
  // are missing from `a`, and `b/inner` is gone with `b`, which the root lists without.
  assert.equal(unlisted, 'a/kept');
});
