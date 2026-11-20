import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, ManagedRuntime } from 'effect';
import {
  toWorkspaceClient as makeEditorClient,
  type WorkspaceClient,
} from '@moonbase/application/testing/editor-fixture';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';
import { acquireEditor, checkout, target, fixture, held } from '../editor-fixture.ts';

test('lookup debounce and A-B-A queries cancel obsolete reads and retain only the exact current result', async () => {
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'A', 'b.ts': 'B' } }]);
  const runtime = ManagedRuntime.make(memory.layer);
  const raw = makeEditorClient(runtime),
    entered = held(),
    release = held();
  let first = true,
    obsoleteSignal: AbortSignal | undefined;
  const client: WorkspaceClient = {
    ...raw,
    async command(name, input, options) {
      if (name === 'lookupFiles' && (input as { query: string }).query === 'a' && first) {
        first = false;
        obsoleteSignal = options?.signal;
        entered.release();
        await release.promise;
      }
      return raw.command(name, input, options);
    },
  };
  const editor = await acquireEditor(runtime, {
    client,
    clientId: 'lookup-races',
    testClock: true,
  });
  await editor.load();
  await editor.openCheckout(checkout.root);
  await editor.flush();
  const lookup = editor.createLookup();
  const complete = () =>
    new Promise<void>((resolve) => {
      const off = lookup.subscribe(() => {
        if (lookup.getSnapshot().message !== 'Searching…') {
          off();
          resolve();
        }
      });
    });
  try {
    lookup.query('a', [checkout]);
    await editor.adjust('119 millis');
    assert.equal(first, true);
    await editor.adjust('1 millis');
    await entered.promise;
    lookup.query('b', [checkout]);
    const b = complete();
    await editor.adjust('120 millis');
    await b;
    assert.equal(obsoleteSignal?.aborted, true);
    assert.equal(lookup.getSnapshot().rows[0].path, 'b.ts');
    lookup.query('a', [checkout]);
    const a = complete();
    await editor.adjust('120 millis');
    await a;
    assert.equal(lookup.getSnapshot().rows[0].path, 'a.ts');
    const snapshot = lookup.getSnapshot();
    release.release();
    await runtime.runPromise(Effect.yieldNow);
    assert.strictEqual(lookup.getSnapshot(), snapshot);
    await lookup.dispose();
    lookup.query('b', [checkout]);
    assert.strictEqual(lookup.getSnapshot(), snapshot);
  } finally {
    release.release();
    await lookup.dispose();
    await editor.dispose();
    await runtime.dispose();
  }
});

test('a refresh neither cancels an open from a lookup nor keeps restarting its query', async () => {
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'A', 'b.ts': 'B', 'c.ts': 'C' } }]);
  const runtime = ManagedRuntime.make(memory.layer);
  const raw = makeEditorClient(runtime);
  let read = held(),
    readEntered = held(),
    holdRead = false,
    holdSearch = false;
  const search = held(),
    searchEntered = held();
  const searches: { query: string; signal?: AbortSignal }[] = [];
  const client: WorkspaceClient = {
    ...raw,
    async command(name, input, options) {
      if (name === 'readFile' && holdRead) {
        readEntered.release();
        await read.promise;
      }
      if (name === 'lookupFiles') {
        searches.push({ query: (input as { query: string }).query, signal: options?.signal });
        if (holdSearch) {
          holdSearch = false;
          searchEntered.release();
          await search.promise;
        }
      }
      return raw.command(name, input, options);
    },
  };
  const editor = await acquireEditor(runtime, {
    client,
    clientId: 'lookup-refresh',
    testClock: true,
  });
  await editor.load();
  await editor.openCheckout(checkout.root);
  await editor.flush();
  const lookup = editor.createLookup();
  const settled = (count: number) =>
    new Promise<void>((resolve) => {
      const off = lookup.subscribe(() => {
        if (searches.length >= count && lookup.getSnapshot().message.endsWith('results')) {
          off();
          resolve();
        }
      });
    });
  const tick = () => editor.adjust('120 millis');
  const openA = () => lookup.open(target('a.ts'), { intent: 'keep' });
  try {
    lookup.query('a', [checkout]);
    const first = settled(1);
    await tick();
    await first;

    // A change on disk re-runs the same query while the reader's open is reading the file.
    holdRead = true;
    const opening = openA();
    await readEntered.promise;
    lookup.query('a', [checkout]);
    assert.notEqual(lookup.getSnapshot().message, 'Searching…', 'A refresh shows no search');
    const refreshed = settled(2);
    await tick();
    await refreshed;
    read.release();
    assert.equal(await opening, true, 'The refresh must not cancel the open');
    assert.equal(editor.getSnapshot().recovery.views.get(checkout.checkoutId)!.active, 'a.ts');

    // A query the reader types still cancels an open in flight.
    read = held();
    readEntered = held();
    const cancelled = openA();
    await readEntered.promise;
    lookup.query('b', [checkout]);
    assert.equal(lookup.getSnapshot().message, 'Searching…');
    read.release();
    assert.equal(await cancelled, false);
    holdRead = false;
    const b = settled(3);
    await tick();
    await b;

    // Refreshes that keep arriving while the query runs rerun it once it answers.
    holdSearch = true;
    lookup.query('c', [checkout]);
    await tick();
    await searchEntered.promise;
    for (let i = 0; i < 3; i++) lookup.query('c', [checkout]);
    await tick();
    const c = settled(searches.length);
    search.release();
    await c;
    assert.equal(lookup.getSnapshot().rows[0].path, 'c.ts');
    const rerun = settled(searches.length + 1);
    // The rerun waits out its own debounce.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    await rerun;
    const cSearches = searches.filter((item) => item.query === 'c');
    assert.equal(cSearches.length, 2, 'One rerun for every refresh that arrived meanwhile');
    assert.equal(cSearches[0].signal?.aborted, false, 'Refreshes never restart the running search');
  } finally {
    read.release();
    search.release();
    await lookup.dispose();
    await editor.dispose();
    await runtime.dispose();
  }
});

test('a failed open stays on screen through refreshes until the reader types again', async () => {
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'A', 'b.ts': 'B' } }]);
  const runtime = ManagedRuntime.make(memory.layer);
  const raw = makeEditorClient(runtime);
  let searches = 0;
  const client: WorkspaceClient = {
    ...raw,
    async command(name, input, options) {
      if (name === 'lookupFiles') searches++;
      return raw.command(name, input, options);
    },
  };
  const editor = await acquireEditor(runtime, {
    client,
    clientId: 'lookup-failed-open',
    testClock: true,
  });
  await editor.load();
  await editor.openCheckout(checkout.root);
  await editor.flush();
  const lookup = editor.createLookup();
  /** Resolves on the first update after the `count`th search. */
  const searched = (count: number) =>
    new Promise<void>((resolve) => {
      const off = lookup.subscribe(() => {
        if (searches >= count && lookup.getSnapshot().message !== 'Searching…') {
          off();
          resolve();
        }
      });
    });
  const tick = () => editor.adjust('120 millis');
  try {
    lookup.query('a', [checkout]);
    let done = searched(1);
    await tick();
    await done;
    memory.failNext('readFile', 'a.ts was deleted');
    assert.equal(await lookup.open(target('a.ts'), { intent: 'keep' }), false);
    assert.match(lookup.getSnapshot().message, /^File unavailable/);
    // A change on disk refreshes the rows but keeps the failure in view.
    const rows = lookup.getSnapshot().rows;
    lookup.query('a', [checkout]);
    done = searched(2);
    await tick();
    await done;
    assert.notStrictEqual(lookup.getSnapshot().rows, rows, 'The refresh delivers its rows');
    assert.match(lookup.getSnapshot().message, /^File unavailable/);
    // A query the reader types replaces it.
    lookup.query('b', [checkout]);
    assert.equal(lookup.getSnapshot().message, 'Searching…');
    done = searched(3);
    await tick();
    await done;
    assert.equal(lookup.getSnapshot().message, '1 results');
  } finally {
    await lookup.dispose();
    await editor.dispose();
    await runtime.dispose();
  }
});

test('typed lookup filters history separately, deduplicates, ranks and highlights independently', async () => {
  const f = await fixture();
  try {
    await f.editor.open(target('a.ts'));
    const blank = await f.editor.lookup(checkout, '');
    assert.equal(blank.matches.length, 0);
    assert.equal(blank.history[0].path, 'a.ts');
    const typed = await f.editor.lookup(checkout, 'ats');
    assert.equal(typed.history[0].path, 'a.ts');
    assert.deepEqual(typed.history[0].positions, [0, 2, 3]);
    assert.equal(
      typed.matches.some((row) => row.path === 'a.ts'),
      false,
    );
    const nested = await f.editor.lookup(checkout, '"nested"');
    assert.equal(nested.matches[0].path, 'folder/nested.ts');
    assert.deepEqual(nested.matches[0].positions, [7, 8, 9, 10, 11, 12]);
    assert.deepEqual((await f.editor.lookup(checkout, 'ignored')).matches, []);
  } finally {
    await f.dispose();
  }
});
