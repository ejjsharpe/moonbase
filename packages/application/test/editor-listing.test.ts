import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acquireEditor } from './editor-model-fixture.ts';
import { checkout, second, fixture, held, target } from './editor-fixture.ts';
import { fileKey } from '@moonbase/application/editor';
import { Effect } from 'effect';

test('overlapping folder reads share one request and later navigation reads fresh entries', async () => {
  const f = await fixture('listing-source', false);
  const entered = held(),
    release = held();
  let calls = 0;
  const editor = await acquireEditor(f.runtime, {
    clientId: 'listing-navigation',
    client: {
      ...f.client,
      watch: () => async () => {},
      async command(name, input, options) {
        if (name === 'listDirectory' && (input as { path: string }).path === 'folder') {
          calls++;
          entered.release();
          await release.promise;
        }
        return f.client.command(name, input, options);
      },
    },
  });
  const reads: Promise<unknown>[] = [];
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    const first = editor.list(checkout, 'folder');
    reads.push(first);
    await entered.promise;
    const second = editor.list(checkout, 'folder');
    reads.push(second);
    await Promise.resolve();
    assert.equal(calls, 1, 'Repeated expansion must not start duplicate filesystem work');
    release.release();
    assert.deepEqual(await first, await second);
    await f.client.command('mutate', {
      checkout,
      clientId: 'listing-source',
      id: 'new-file',
      kind: 'create-file',
      sources: [],
      destination: 'folder/new.ts',
      text: 'new',
    });
    assert(
      (await editor.list(checkout, 'folder')).entries.some(
        (entry) => entry.path === 'folder/new.ts',
      ),
    );
    assert.equal(calls, 2);
  } finally {
    release.release();
    await Promise.allSettled(reads);
    await editor.dispose();
    await f.dispose();
  }
});

test('first folder listing is visible while Git is held, and stale classifications cannot replace newer results', async () => {
  const f = await fixture('listing-isolation-source', false);
  const entered = held(),
    release = held(),
    classified = held();
  let hold = false;
  let obsoleteSignal: AbortSignal | undefined;
  const editor = await acquireEditor(f.runtime, {
    clientId: 'listing-isolation',
    client: {
      ...f.client,
      watch: () => async () => {},
      async command(name, input, options) {
        if (hold && name === 'getIgnoredPaths' && (input as { path: string }).path === '') {
          hold = false;
          obsoleteSignal = options?.signal;
          const listing = await f.client.command(name, input, options);
          (listing as { paths: string[] }).paths = [];
          entered.release();
          await release.promise;
          return listing;
        }
        return f.client.command(name, input, options);
      },
    },
  });
  const off = editor.subscribe(() => {
    if (
      editor
        .getSnapshot()
        .listings[fileKey(target(''))]?.entries.find((entry) => entry.path === 'c.ts')?.ignored
    )
      classified.release();
  });
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    await editor.openCheckout(second.root);
    hold = true;
    editor.tree(checkout, { hideIgnored: true });
    const unfiltered = await editor.list(checkout);
    await entered.promise;
    assert(unfiltered.entries.some((entry) => entry.path === 'c.ts'));
    assert(unfiltered.entries.every((entry) => entry.ignored === undefined));
    assert(
      editor
        .getSnapshot()
        .listings[fileKey(target(''))].entries.some((entry) => entry.path === 'c.ts'),
    );
    const other = await editor.list(second);
    assert(other.entries.some((entry) => entry.path === 'c.ts'));
    assert.equal(obsoleteSignal?.aborted, false, 'Other checkouts retain their classification');
    await editor.list(checkout);
    assert.equal(obsoleteSignal?.aborted, true, 'Superseded classification must be cancelled');
    await classified.promise;
    release.release();
    await f.runtime.runPromise(Effect.yieldNow);
    assert(
      editor
        .getSnapshot()
        .listings[fileKey(target(''))].entries.find((entry) => entry.path === 'c.ts')?.ignored,
    );
    f.memory.failNext('listDirectory', 'Temporary listing failure');
    await assert.rejects(editor.list(checkout), /Temporary listing failure/);
    assert((await editor.list(checkout)).entries.some((entry) => entry.path === 'c.ts'));
  } finally {
    release.release();
    off();
    await editor.dispose();
    await f.dispose();
  }
});

test('filesystem changes refresh past a held folder read and older replies cannot replace fresh entries', async () => {
  const f = await fixture('listing-watcher-source', false);
  const entered = held(),
    release = held(),
    refreshed = held();
  let hold = false;
  const editor = await acquireEditor(f.runtime, {
    clientId: 'listing-watcher',
    client: {
      ...f.client,
      async command(name, input, options) {
        const result = await f.client.command(name, input, options);
        if (hold && name === 'listDirectory' && (input as { path: string }).path === 'folder') {
          hold = false;
          entered.release();
          await release.promise;
        }
        return result;
      },
    },
  });
  let pending: Promise<unknown> | undefined;
  const off = editor.subscribe(() => {
    if (
      editor
        .getSnapshot()
        .listings[fileKey(target('folder'))]?.entries.some(
          (entry) => entry.path === 'folder/new.ts',
        )
    )
      refreshed.release();
  });
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    editor.tree(checkout, { expanded: ['folder'] });
    hold = true;
    pending = editor.list(checkout, 'folder');
    await entered.promise;
    await f.client.command('mutate', {
      checkout,
      clientId: 'listing-watcher-source',
      id: 'new-watched-file',
      kind: 'create-file',
      sources: [],
      destination: 'folder/new.ts',
      text: 'new',
    });
    await Promise.race([
      refreshed.promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(Error('Folder refresh waited for an obsolete read')), 1000),
      ),
    ]);
    release.release();
    await pending;
    assert(
      editor
        .getSnapshot()
        .listings[fileKey(target('folder'))].entries.some(
          (entry) => entry.path === 'folder/new.ts',
        ),
    );
  } finally {
    release.release();
    await pending;
    off();
    await editor.dispose();
    await f.dispose();
  }
});

test('ignore failures keep files visible, retries can classify, and disposal cancels held metadata', async () => {
  const f = await fixture('listing-ignore-lifetime-source', false);
  const failed = held(),
    entered = held(),
    release = held(),
    classified = held();
  let mode: 'fail' | 'classify' | 'hold' = 'fail';
  let signal: AbortSignal | undefined;
  const editor = await acquireEditor(f.runtime, {
    clientId: 'listing-ignore-lifetime',
    client: {
      ...f.client,
      watch: () => async () => {},
      async command(name, input, options) {
        if (name === 'getIgnoredPaths' && (input as { path: string }).path === 'folder') {
          if (mode === 'fail') {
            f.memory.failNext('getIgnoredPaths', 'Ignore classification failed');
          } else if (mode === 'hold') {
            signal = options?.signal;
            entered.release();
            await release.promise;
          }
        }
        return f.client.command(name, input, options);
      },
    },
  });
  const off = editor.subscribe(() => {
    const state = editor.getSnapshot();
    if (state.errors.some((error) => error.includes('Ignore classification failed')))
      failed.release();
    if (state.listings[fileKey(target('folder'))]?.entries[0]?.ignored === false)
      classified.release();
  });
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    assert.equal((await editor.list(checkout, 'folder')).entries[0].path, 'folder/nested.ts');
    await failed.promise;
    assert.equal(editor.getSnapshot().listings[fileKey(target('folder'))].entries.length, 1);
    mode = 'classify';
    await editor.list(checkout, 'folder');
    await classified.promise;
    mode = 'hold';
    await editor.list(checkout, 'folder');
    await entered.promise;
    await editor.dispose();
    assert.equal(signal?.aborted, true);
    const disposed = editor.getSnapshot();
    release.release();
    await f.runtime.runPromise(Effect.yieldNow);
    assert.equal(editor.getSnapshot(), disposed);
  } finally {
    release.release();
    off();
    await editor.dispose();
    await f.dispose();
  }
});
