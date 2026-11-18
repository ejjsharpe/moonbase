import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, ManagedRuntime } from 'effect';
import { ApplicationError, type WorkspaceEvent } from '@moonbase/contracts/workspace';
import {
  toWorkspaceClient as makeEditorClient,
  type WorkspaceClient,
} from '@moonbase/application/testing/editor-fixture';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';
import { acquireEditor } from './editor-model-fixture.ts';
import { checkout, target } from './editor-fixture.ts';

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

test('two editors share one workspace, and a disposed editor accepts and sends nothing', async () => {
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'A' } }]);
  const runtime = ManagedRuntime.make(memory.layer);
  const raw = makeEditorClient(runtime);
  let late!: (event: WorkspaceEvent) => void;
  const client: WorkspaceClient = {
    ...raw,
    watch(input, receive, onError) {
      late = receive;
      return raw.watch(input, receive, onError);
    },
  };
  const first = await acquireEditor(runtime, { client, clientId: 'first-model' });
  const second = await acquireEditor(runtime, { client: raw, clientId: 'second-model' });
  try {
    for (const editor of [first, second]) {
      await editor.load();
      await editor.openCheckout(checkout.root);
    }
    assert.notEqual(first.instanceId, second.instanceId);
    await first.open(target('a.ts'));
    first.edit(target('a.ts'), 'saved draft');
    await first.flush();
    const stored = JSON.stringify(await raw.command('loadRecovery', { clientId: first.clientId }));
    const closing = first.dispose();
    assert.strictEqual(first.dispose(), closing);
    await closing;
    assert.equal(first.getSnapshot().disposed, true);
    const snapshot = first.getSnapshot();
    late({ checkout, paths: ['a.ts'] });
    assert.strictEqual(first.getSnapshot(), snapshot);
    await assert.rejects(first.open(target('a.ts')));
    await second.open(target('a.ts'));
    second.edit(target('a.ts'), 'second draft');
    await second.flush();
    assert.equal((await raw.command('readFile', target('a.ts'))).text, 'A');
    assert.equal(
      JSON.stringify(await raw.command('loadRecovery', { clientId: first.clientId })),
      stored,
      'a disposed editor sends no edits',
    );
  } finally {
    await first.dispose();
    await second.dispose();
    await runtime.dispose();
  }
});

test('exact close prompts ignore stale answers and disposal cancels an outstanding prompt', async () => {
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'A' } }]);
  const runtime = ManagedRuntime.make(memory.layer);
  const editor = await acquireEditor(runtime, {
    client: makeEditorClient(runtime),
    clientId: 'prompts',
  });
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    await editor.open(target('a.ts'));
    editor.edit(target('a.ts'), 'dirty');
    const closing = editor.close([target('a.ts')]);
    const prompt = editor.getSnapshot().closePrompt!;
    assert(prompt);
    editor.answerClose('stale-prompt', 'discard');
    assert.equal(editor.getSnapshot().closePrompt?.id, prompt.id);
    editor.answerClose(prompt.id, 'cancel');
    assert.equal(await closing, false);
    const next = editor.close([target('a.ts')]);
    // Disposal answers the outstanding prompt Cancel, or ends the close with the editor.
    const result = next.catch(() => false);
    await editor.dispose();
    assert.equal(await result, false);
    assert.equal(editor.getSnapshot().closePrompt, null);
  } finally {
    await editor.dispose();
    await runtime.dispose();
  }
});

test('lookup debounce and A-B-A queries cancel obsolete reads and retain only the exact current result', async () => {
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'A', 'b.ts': 'B' } }]);
  const runtime = ManagedRuntime.make(memory.layer);
  const raw = makeEditorClient(runtime),
    entered = gate(),
    release = gate();
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
  let read = gate(),
    readEntered = gate(),
    holdRead = false,
    holdSearch = false;
  const search = gate(),
    searchEntered = gate();
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
  const openA = () =>
    lookup.open((current) => editor.open(target('a.ts'), { intent: 'keep', current }));
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
    read = gate();
    readEntered = gate();
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
    assert.equal(
      await lookup.open((current) => editor.open(target('a.ts'), { intent: 'keep', current })),
      false,
    );
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

test('checkout close cancels its in-flight observer refresh without reporting obsolete read cancellation', async () => {
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'A' } }]);
  const runtime = ManagedRuntime.make(memory.layer),
    raw = makeEditorClient(runtime),
    entered = gate(),
    release = gate();
  let held = false,
    signal: AbortSignal | undefined;
  const client: WorkspaceClient = {
    ...raw,
    async command(name, input, options) {
      if (held && name === 'listDirectory') {
        signal = options?.signal;
        entered.release();
        await release.promise;
      }
      return raw.command(name, input, options);
    },
  };
  const editor = await acquireEditor(runtime, { client, clientId: 'closing-refresh' });
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    await editor.open(target('a.ts'));
    await editor.flush();
    held = true;
    memory.externalWrite(target('a.ts'), 'B');
    await entered.promise;
    assert.equal(await editor.closeCheckout(checkout), true);
    assert.equal(signal?.aborted, true);
    assert.deepEqual(editor.getSnapshot().errors, []);
    const snapshot = editor.getSnapshot();
    release.release();
    await runtime.runPromise(Effect.yieldNow);
    assert.strictEqual(editor.getSnapshot(), snapshot);
  } finally {
    release.release();
    await editor.dispose();
    await runtime.dispose();
  }
});

test('selected file replacement cancels held comparison refresh and checkout close cancels held reveal reads', async () => {
  const memory = fauxWorkspace([
    {
      checkout,
      files: { 'a.ts': 'A', 'b.ts': 'B', 'folder/c.ts': 'C' },
      head: { 'a.ts': 'HEAD A' },
      index: { 'a.ts': 'INDEX A' },
    },
  ]);
  const runtime = ManagedRuntime.make(memory.layer),
    raw = makeEditorClient(runtime);
  let heldName = '',
    entered = gate(),
    release = gate(),
    signal: AbortSignal | undefined;
  const wasAborted = () => signal?.aborted;
  const client: WorkspaceClient = {
    ...raw,
    async command(name, input, options) {
      if (name === heldName) {
        signal = options?.signal;
        entered.release();
        await release.promise;
      }
      return raw.command(name, input, options);
    },
  };
  const editor = await acquireEditor(runtime, { client, clientId: 'owned-read-scopes' });
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    await editor.open(target('a.ts'), { view: 'staged' });
    heldName = 'readComparison';
    const refresh = editor.refresh(checkout);
    await entered.promise;
    await editor.open(target('b.ts'));
    assert.equal(wasAborted(), true);
    release.release();
    await refresh;
    entered = gate();
    release = gate();
    heldName = 'listDirectory';
    signal = undefined;
    // Closing the checkout aborts the held read and abandons the reveal, which resolves false.
    const reveal = editor.reveal(target('folder/c.ts'));
    await entered.promise;
    assert.equal(await editor.closeCheckout(checkout), true);
    assert.equal(wasAborted(), true);
    release.release();
    assert.equal(await reveal, false);
  } finally {
    release.release();
    await editor.dispose();
    await runtime.dispose();
  }
});

test('cached and implicit checkout selection retain an exact owner for comparison refresh cancellation', async () => {
  const other = { ...checkout, checkoutId: 'other', root: '/memory/other' };
  const memory = fauxWorkspace(
    [checkout, other].map((checkout) => ({
      checkout,
      files: { 'a.ts': 'A', 'b.ts': 'B' },
      head: { 'a.ts': 'HEAD A' },
      index: { 'a.ts': 'INDEX A' },
    })),
  );
  const runtime = ManagedRuntime.make(memory.layer),
    raw = makeEditorClient(runtime);
  let held = false,
    entered = gate(),
    release = gate(),
    observed: AbortSignal | undefined;
  const aborted = () => observed?.aborted;
  const client: WorkspaceClient = {
    ...raw,
    async command(name, input, options) {
      if (held && name === 'readComparison') {
        observed = options?.signal;
        entered.release();
        await release.promise;
      }
      return raw.command(name, input, options);
    },
  };
  const editor = await acquireEditor(runtime, { client, clientId: 'cached-selection' });
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    await editor.open(target('a.ts'), { view: 'staged' });
    await editor.openCheckout(other.root);
    await editor.open({ checkout: other, path: 'a.ts' }, { view: 'staged' });
    await editor.selectCheckout(checkout);
    held = true;
    const refresh = editor.refresh(checkout);
    await entered.promise;
    await editor.selectCheckout(other);
    assert.equal(aborted(), true);
    release.release();
    await refresh;
    held = false;
    await editor.closeCheckout(other); // Implicitly selects cached checkout A.
    entered = gate();
    release = gate();
    observed = undefined;
    held = true;
    const implicit = editor.refresh(checkout);
    await entered.promise;
    await editor.open(target('b.ts'));
    assert.equal(aborted(), true);
    release.release();
    await implicit;
    assert.deepEqual(editor.getSnapshot().errors, []);
  } finally {
    release.release();
    await editor.dispose();
    await runtime.dispose();
  }
});

test('UI report callbacks ignore only cancellation from a closed captured read owner', async () => {
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'A', 'folder/c.ts': 'C' } }]);
  const runtime = ManagedRuntime.make(memory.layer),
    raw = makeEditorClient(runtime),
    entered = gate(),
    release = gate();
  let held = false;
  const client: WorkspaceClient = {
    ...raw,
    async command(name, input, options) {
      if (held && name === 'listDirectory') {
        entered.release();
        await release.promise;
      }
      return raw.command(name, input, options);
    },
  };
  const editor = await acquireEditor(runtime, { client, clientId: 'ui-read-errors' });
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    await editor.open(target('a.ts'));
    await editor.flush();
    held = true;
    const reveal = editor.reveal(target('folder/c.ts')).catch(editor.report);
    const refresh = editor.refresh(checkout).catch(editor.report);
    const tree = editor.list(checkout, 'folder').catch(editor.report);
    await entered.promise;
    assert.equal(await editor.closeCheckout(checkout), true);
    release.release();
    await Promise.all([reveal, refresh, tree]);
    assert.deepEqual(editor.getSnapshot().errors, []);
    editor.report(new ApplicationError({ code: 'Persistence', message: 'Real cleanup failure' }));
    assert.deepEqual(editor.getSnapshot().errors, ['Real cleanup failure']);
    editor.report(
      new ApplicationError({ code: 'Cancelled', message: 'Unrelated active cancellation' }),
    );
    assert.deepEqual(editor.getSnapshot().errors, [
      'Real cleanup failure',
      'Unrelated active cancellation',
    ]);
  } finally {
    release.release();
    await editor.dispose();
    await runtime.dispose();
  }
});

test('typed compound Cancelled failures stay visible', async () => {
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'A' } }]);
  const runtime = ManagedRuntime.make(memory.layer),
    raw = makeEditorClient(runtime);
  const compound = new ApplicationError({
    code: 'Cancelled',
    message: 'Cancelled read; Real cleanup failure',
  });
  let fault = '';
  const client: WorkspaceClient = {
    ...raw,
    command(name, input, options) {
      return name === fault ? Promise.reject(compound) : raw.command(name, input, options);
    },
  };
  const editor = await acquireEditor(runtime, { client, clientId: 'compound-read-errors' });
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    await editor.open(target('a.ts'));
    await editor.flush();
    fault = 'gitStatus';
    await editor.refresh(checkout);
    assert(editor.getSnapshot().errors.includes(compound.message));
  } finally {
    await editor.dispose();
    await runtime.dispose();
  }
});

test('untyped injected read, lookup and inspection errors cannot publish private diagnostics', async () => {
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'A' } }]);
  const runtime = ManagedRuntime.make(memory.layer),
    raw = makeEditorClient(runtime);
  const sentinel = 'api_key=SYNTHETIC_PRIVATE_CLIENT_VALUE';
  let fault = '';
  const client: WorkspaceClient = {
    ...raw,
    command(name, input, options) {
      return name === fault ? Promise.reject(Error(sentinel)) : raw.command(name, input, options);
    },
  };
  const editor = await acquireEditor(runtime, {
    client,
    clientId: 'raw-client-errors',
    testClock: true,
  });
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    fault = 'readFile';
    assert.equal(await editor.open(target('a.ts')), false);
    assert(editor.getSnapshot().errors.includes('Application effect failed'));
    assert(!JSON.stringify(editor.getSnapshot()).includes(sentinel));
    fault = 'lookupFiles';
    const lookup = editor.createLookup();
    const complete = new Promise<void>((resolve) => {
      const off = lookup.subscribe(() => {
        if (lookup.getSnapshot().message !== 'Searching…') {
          off();
          resolve();
        }
      });
    });
    lookup.query('a', [checkout]);
    await editor.adjust('120 millis');
    await complete;
    assert(lookup.getSnapshot().message.includes('Application effect failed'));
    assert(!JSON.stringify(lookup.getSnapshot()).includes(sentinel));
    await lookup.dispose();
    fault = 'inspectEntries';
    const result = await editor.mutations.run(
      { checkout, kind: 'move', paths: ['a.ts'] },
      'moved.ts',
    );
    assert.equal(result.completed, false);
    assert.equal(result.error, 'Application effect failed');
    assert(!JSON.stringify(result).includes(sentinel));
  } finally {
    await editor.dispose();
    await runtime.dispose();
  }
});
