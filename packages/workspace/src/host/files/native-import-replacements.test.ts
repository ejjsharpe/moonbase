import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { WorkspaceNative } from '../../index.ts';
import { fixture, isError, quote } from '../../../test/fixtures/recovery-fixture.ts';

/**
 * A checkout with `dest/` holding `existing`, Finder files `dropped` outside it captured as native
 * references, and a helper that counts Trash calls.
 */
async function setup(existing: string, dropped: string[]) {
  const f = fixture(),
    trashCount = join(f.base, 'trash-count');
  const { runtime, client } = f.start(
    f.wrapper(`if [ "$1" = trash ]; then printf 'trash\\n' >> ${quote(trashCount)}; fi`),
  );
  mkdirSync(join(f.root, 'dest'));
  writeFileSync(join(f.root, 'dest', existing), 'keep');
  mkdirSync(join(f.base, 'finder'));
  for (const name of dropped) writeFileSync(join(f.base, 'finder', name), 'dropped ' + name);
  const checkout = await client.command('openCheckout', { root: f.root });
  const nativeReferences = await runtime.runPromise(
    Effect.flatMap(WorkspaceNative, (native) =>
      native.capture({
        checkout,
        clientId: 'alice',
        paths: dropped.map((name) => join(f.base, 'finder', name)),
      }),
    ),
  );
  return {
    f,
    client,
    checkout,
    nativeReferences,
    trashed: () => existsSync(trashCount),
    close: async () => {
      await runtime.dispose();
      f.cleanup();
    },
  };
}

test('a batch import refuses a replacement no dropped source lands on, and changes nothing', async () => {
  // As if the renderer named the files `c.txt` and `b.txt`: the first source is really `a.txt`.
  const t = await setup('c.txt', ['a.txt', 'b.txt']);
  try {
    const replacements = await t.client.command('inspectEntries', {
      checkout: t.checkout,
      paths: ['dest/c.txt'],
    });
    await assert.rejects(
      t.client.command('mutate', {
        id: 'mismatched-replacement',
        clientId: 'alice',
        checkout: t.checkout,
        kind: 'import',
        sources: [],
        nativeReferences: t.nativeReferences,
        destination: 'dest',
        replacements,
      }),
      (error) =>
        isError('InvalidInput')(error) &&
        (error as Error).message.includes('Replacement must name the exact captured destination.'),
    );
    assert.equal(readFileSync(join(t.f.root, 'dest/c.txt'), 'utf8'), 'keep');
    assert(!existsSync(join(t.f.root, 'dest/a.txt')));
    assert(!existsSync(join(t.f.root, 'dest/b.txt')));
    assert(!t.trashed(), 'A refused replacement must not reach the Trash.');
  } finally {
    await t.close();
  }
});

test('a batch import onto an existing name it did not propose replacing overwrites nothing', async () => {
  const t = await setup('a.txt', ['a.txt', 'b.txt']);
  try {
    const result = await t.client.command('mutate', {
      id: 'unproposed-collision',
      clientId: 'alice',
      checkout: t.checkout,
      kind: 'import',
      sources: [],
      nativeReferences: t.nativeReferences,
      destination: 'dest',
      replacements: [],
    });
    // The import fails on the existing entry, and the batch stops there.
    assert.notEqual(result.outcome, 'completed');
    assert.deepEqual(
      result.items.map((item) => [item.destination, item.outcome !== 'completed']),
      [['dest/a.txt', true]],
    );
    assert.equal(readFileSync(join(t.f.root, 'dest/a.txt'), 'utf8'), 'keep');
    // Nothing else landed, not even a staged copy.
    assert.deepEqual(readdirSync(join(t.f.root, 'dest')), ['a.txt']);
    assert(!t.trashed(), 'An unproposed collision must not reach the Trash.');
  } finally {
    await t.close();
  }
});
