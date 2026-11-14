import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Exit, ManagedRuntime, Scope } from 'effect';
import {
  ApplicationError,
  emptyRecovery,
  type EditorClient,
  type RecoveryLoad,
  type WorkspaceEvent,
} from '@moonbase/contracts/workspace';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import { makeEditorController, makeEditorModel } from '@moonbase/application/editor';
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

test('one acquired model binds once; two models share one runtime and failed held cleanup stays pending and observable', async () => {
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'A' } }]);
  const runtime = ManagedRuntime.make(memory.layer),
    root = Scope.makeUnsafe();
  const raw = makeEditorClient(runtime),
    entered = gate(),
    release = gate();
  let late!: (event: WorkspaceEvent) => void;
  const client: EditorClient = {
    ...raw,
    watch(input, receive, onError) {
      late = receive;
      const close = raw.watch(input, receive, onError);
      let completion: Promise<void> | undefined;
      return () =>
        (completion ??= (async () => {
          await close();
          entered.release();
          await release.promise;
          throw new ApplicationError({
            code: 'Persistence',
            message: 'Observation cleanup failed',
          });
        })());
    },
  };
  const acquire = (dependencies: Parameters<typeof makeEditorModel>[0]) =>
    runtime.runPromise(
      makeEditorModel(dependencies).pipe(Effect.provideService(Scope.Scope, root)),
    );
  const firstModel = await acquire({ client, clientId: 'first-model' });
  const first = makeEditorController(runtime, firstModel);
  assert.throws(() => makeEditorController(runtime, firstModel), /already bound/);
  const second = makeEditorController(
    runtime,
    await acquire({ client: raw, clientId: 'second-model' }),
  );
  const appErrors: ApplicationError[] = [];
  try {
    for (const editor of [first, second]) {
      await editor.load();
      await editor.openCheckout(checkout.root);
    }
    assert.notEqual(first.instanceId, second.instanceId);
    await first.open(target('a.ts'));
    first.edit(target('a.ts'), 'saved draft');
    await first.flush();
    const closing = first.dispose();
    assert.strictEqual(first.dispose(), closing);
    const tracked = closing.catch((error) => {
      assert(ApplicationError.is(error));
      appErrors.push(error);
    });
    await entered.promise;
    assert.equal(first.getSnapshot().disposed, false);
    const snapshot = first.getSnapshot(),
      publications = memory.stats.publications;
    late({ checkout, paths: ['a.ts'] });
    assert.strictEqual(first.getSnapshot(), snapshot);
    await assert.rejects(first.open(target('a.ts')), /disposed/);
    await second.open(target('a.ts'));
    second.edit(target('a.ts'), 'second draft');
    await second.flush();
    assert.equal((await raw.command('readFile', target('a.ts'))).text, 'A');
    release.release();
    await tracked;
    assert.equal(appErrors.length, 1);
    assert.equal(appErrors[0].code, 'Persistence');
    assert.equal(first.getSnapshot().disposed, false);
    await assert.rejects(first.dispose(), /Observation cleanup failed/);
    assert.equal(memory.stats.publications, publications + 1);
    await second.dispose();
    assert.equal(second.getSnapshot().disposed, true);
  } finally {
    release.release();
    await first.dispose().catch(() => {});
    await second.dispose();
    // A failed child finalizer remains an honest root-close failure too.
    await runtime.runPromiseExit(Scope.close(root, Exit.void));
    await runtime.dispose();
  }
});

test('prior producer unfamiliar nested saved draft blocks load/edit/publication and leaves original saved bytes unchanged', async () => {
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'A' } }]);
  const runtime = ManagedRuntime.make(memory.layer),
    raw = makeEditorClient(runtime);
  const state = emptyRecovery('strict-producer');
  state.checkouts = [checkout];
  state.openCheckoutIds = [checkout.checkoutId];
  state.selectedCheckoutId = checkout.checkoutId;
  const prior = {
    ...state,
    drafts: [
      {
        target: target('a.ts'),
        text: 'irreplaceable draft',
        disk: { text: 'A', version: '1' },
        futureMetadata: { preserve: true },
      },
    ],
  };
  const original = JSON.stringify(prior);
  let publications = 0;
  const client: EditorClient = {
    ...raw,
    async command(name, input, options) {
      if (name === 'persistRecovery') publications++;
      if (name === 'loadRecovery')
        return {
          revision: 1,
          state: structuredClone(prior),
          errors: [],
          operations: [],
        } as RecoveryLoad;
      return raw.command(name, input, options);
    },
  };
  const editor = await acquireEditor(runtime, { client, clientId: state.clientId });
  try {
    await assert.rejects(
      editor.load(),
      (error) => ApplicationError.is(error) && error.code === 'Incompatible',
    );
    assert.equal(editor.getSnapshot().ready, false);
    assert.equal(editor.getSnapshot().recoveryReady, false);
    assert.throws(() => editor.edit(target('a.ts'), 'new text'), /Load editor recovery/);
    await assert.rejects(editor.flush(), /Load editor recovery/);
    assert.equal(publications, 0);
    assert.equal(memory.stats.publications, 0);
    assert.equal(JSON.stringify(prior), original);
  } finally {
    await editor.dispose();
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
    const result = next.catch((error) => {
      assert(ApplicationError.is(error));
      assert.equal(error.code, 'Cancelled');
      return false;
    });
    await editor.dispose();
    assert.equal(await result, false);
    assert.equal(editor.getSnapshot().closePrompt, null);
  } finally {
    await editor.dispose();
    await runtime.dispose();
  }
});

test('lookup debounce and A-B-A queries cancel obsolete reads and retain only the exact current result', async () => {
  const { Layer } = await import('effect');
  const { TestClock } = await import('effect/testing');
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'A', 'b.ts': 'B' } }]);
  const runtime = ManagedRuntime.make(Layer.merge(memory.layer, TestClock.layer()));
  const raw = makeEditorClient(runtime),
    entered = gate(),
    release = gate();
  let first = true,
    obsoleteSignal: AbortSignal | undefined;
  const client: EditorClient = {
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
  const editor = await acquireEditor(runtime, { client, clientId: 'lookup-races' });
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
    await runtime.runPromise(TestClock.adjust('119 millis'));
    assert.equal(first, true);
    await runtime.runPromise(TestClock.adjust('1 millis'));
    await entered.promise;
    lookup.query('b', [checkout]);
    const b = complete();
    await runtime.runPromise(TestClock.adjust('120 millis'));
    await b;
    assert.equal(obsoleteSignal?.aborted, true);
    assert.equal(lookup.getSnapshot().rows[0].path, 'b.ts');
    lookup.query('a', [checkout]);
    const a = complete();
    await runtime.runPromise(TestClock.adjust('120 millis'));
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
  const { Layer } = await import('effect');
  const { TestClock } = await import('effect/testing');
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'A', 'b.ts': 'B', 'c.ts': 'C' } }]);
  const runtime = ManagedRuntime.make(Layer.merge(memory.layer, TestClock.layer()));
  const raw = makeEditorClient(runtime);
  let read = gate(),
    readEntered = gate(),
    holdRead = false,
    holdSearch = false;
  const search = gate(),
    searchEntered = gate();
  const searches: { query: string; signal?: AbortSignal }[] = [];
  const client: EditorClient = {
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
  const editor = await acquireEditor(runtime, { client, clientId: 'lookup-refresh' });
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
  const tick = () => runtime.runPromise(TestClock.adjust('120 millis'));
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
    assert.equal(editor.getSnapshot().recovery.views[checkout.checkoutId].active, 'a.ts');

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
  const { Layer } = await import('effect');
  const { TestClock } = await import('effect/testing');
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'A', 'b.ts': 'B' } }]);
  const runtime = ManagedRuntime.make(Layer.merge(memory.layer, TestClock.layer()));
  const raw = makeEditorClient(runtime);
  let searches = 0;
  const client: EditorClient = {
    ...raw,
    async command(name, input, options) {
      if (name === 'lookupFiles') searches++;
      return raw.command(name, input, options);
    },
  };
  const editor = await acquireEditor(runtime, { client, clientId: 'lookup-failed-open' });
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
  const tick = () => runtime.runPromise(TestClock.adjust('120 millis'));
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

test('dismissing inspection admits no mutation; dismissing after dispatch retains model-owned outcome exactly once', async () => {
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'A' } }]);
  const runtime = ManagedRuntime.make(memory.layer),
    raw = makeEditorClient(runtime);
  const inspecting = gate(),
    inspectReply = gate(),
    admitted = gate(),
    mutateReply = gate();
  let holdInspection = true,
    holdMutation = false;
  const client: EditorClient = {
    ...raw,
    async command(name, input, options) {
      if (name === 'inspectEntries' && holdInspection) {
        inspecting.release();
        await inspectReply.promise;
      }
      const result = await raw.command(name, input, options);
      if (name === 'mutate' && holdMutation) {
        admitted.release();
        await mutateReply.promise;
      }
      return result;
    },
  };
  const editor = await acquireEditor(runtime, { client, clientId: 'mutation-scopes' });
  await editor.load();
  await editor.openCheckout(checkout.root);
  await editor.open(target('a.ts'));
  editor.edit(target('a.ts'), 'dirty A');
  await editor.flush();
  const action = { checkout, kind: 'move' as const, paths: ['a.ts'] };
  const before = editor.createMutation(action);
  try {
    const pending = before.apply('moved.ts', '', false);
    await inspecting.promise;
    await before.dispose();
    inspectReply.release();
    assert.equal(await pending, false);
    assert.equal((await raw.command('readFile', target('a.ts'))).text, 'A');
    assert.equal(editor.getSnapshot().operations.length, 0);
    holdInspection = false;
    holdMutation = true;
    const after = editor.createMutation(action);
    const result = after.apply('moved.ts', '', false);
    await admitted.promise;
    await after.dispose();
    mutateReply.release();
    assert.equal(await result, false);
    assert.equal((await raw.command('readFile', target('moved.ts'))).text, 'A');
    assert.equal(editor.buffer(target('moved.ts'))?.text, 'dirty A');
    assert.equal(editor.getSnapshot().operations.length, 0);
    await after.dispose();
  } finally {
    inspectReply.release();
    mutateReply.release();
    await before.dispose();
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
  const client: EditorClient = {
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
  const client: EditorClient = {
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

test('model disposal joins an already-detached checkout watch close and retains its failed outcome', async () => {
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'A' } }]);
  const runtime = ManagedRuntime.make(memory.layer),
    raw = makeEditorClient(runtime),
    entered = gate(),
    release = gate();
  const client: EditorClient = {
    ...raw,
    watch(input, receive, onError) {
      const close = raw.watch(input, receive, onError);
      let completion: Promise<void> | undefined;
      return () =>
        (completion ??= (async () => {
          await close();
          entered.release();
          await release.promise;
          throw new ApplicationError({
            code: 'Persistence',
            message: 'Detached observation release failed',
          });
        })());
    },
  };
  const editor = await acquireEditor(runtime, { client, clientId: 'detached-close' });
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    const checkoutClose = editor.closeCheckout(checkout);
    await entered.promise;
    const closing = editor.dispose();
    assert.strictEqual(editor.dispose(), closing);
    const failed = assert.rejects(
      closing,
      (error) =>
        ApplicationError.is(error) &&
        error.code === 'Persistence' &&
        /Detached observation release failed/.test(error.message),
    );
    let settled = false;
    void closing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await runtime.runPromise(Effect.yieldNow);
    assert.equal(settled, false);
    assert.equal(editor.getSnapshot().disposed, false);
    release.release();
    await failed;
    assert.equal(await checkoutClose, true);
    assert.equal(editor.getSnapshot().disposed, false);
    await assert.rejects(editor.dispose(), /Detached observation release failed/);
  } finally {
    release.release();
    await editor.dispose().catch(() => {});
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
  const client: EditorClient = {
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
  const client: EditorClient = {
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

test('raw observation cleanup rejection is safely normalized without losing typed cleanup failures', async () => {
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'A' } }]);
  const runtime = ManagedRuntime.make(memory.layer),
    raw = makeEditorClient(runtime);
  const sentinel = 'api_key=SYNTHETIC_PRIVATE_RELEASE_VALUE';
  const client: EditorClient = {
    ...raw,
    watch(input, receive, onError) {
      const close = raw.watch(input, receive, onError);
      let completion: Promise<void> | undefined;
      return () =>
        (completion ??= close().then(() => {
          throw Error(sentinel);
        }));
    },
  };
  const editor = await acquireEditor(runtime, { client, clientId: 'raw-release' });
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    await assert.rejects(
      editor.dispose(),
      (error) =>
        ApplicationError.is(error) &&
        error.code === 'Unavailable' &&
        !error.message.includes(sentinel),
    );
    await assert.rejects(editor.dispose(), (error) => !String(error).includes(sentinel));
    assert.equal(editor.getSnapshot().disposed, false);
  } finally {
    await editor.dispose().catch(() => {});
    await runtime.dispose();
  }
});

test('typed compound Cancelled failures remain visible for active and newly closed read owners', async () => {
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'A' } }]);
  const runtime = ManagedRuntime.make(memory.layer),
    raw = makeEditorClient(runtime);
  const compound = new ApplicationError({
    code: 'Cancelled',
    message: 'Cancelled read; Real cleanup failure',
  });
  const entered = gate(),
    release = gate();
  let delayExit = false,
    fault = '';
  const delayed: typeof runtime = {
    ...runtime,
    async runPromiseExit(effect, options) {
      const exit = await runtime.runPromiseExit(effect, options);
      if (
        delayExit &&
        Exit.isFailure(exit) &&
        exit.cause.reasons.some((reason) => reason._tag === 'Fail' && reason.error === compound)
      ) {
        delayExit = false;
        entered.release();
        await release.promise;
      }
      return exit;
    },
  };
  const client: EditorClient = {
    ...raw,
    command(name, input, options) {
      return name === fault ? Promise.reject(compound) : raw.command(name, input, options);
    },
  };
  const editor = await acquireEditor(delayed, { client, clientId: 'compound-read-errors' });
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    await editor.open(target('a.ts'));
    await editor.flush();
    fault = 'gitStatus';
    await editor.refresh(checkout);
    assert(editor.getSnapshot().errors.includes(compound.message));
    editor.clearErrors();
    fault = 'listDirectory';
    delayExit = true;
    const list = editor.list(checkout, '').catch(editor.report);
    await entered.promise;
    fault = '';
    assert.equal(await editor.closeCheckout(checkout), true);
    release.release();
    await list;
    assert(editor.getSnapshot().errors.includes(compound.message));
  } finally {
    release.release();
    await editor.dispose();
    await runtime.dispose();
  }
});

test('untyped injected read, lookup and inspection errors cannot publish private diagnostics', async () => {
  const { Layer } = await import('effect');
  const { TestClock } = await import('effect/testing');
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'A' } }]);
  const runtime = ManagedRuntime.make(Layer.merge(memory.layer, TestClock.layer())),
    raw = makeEditorClient(runtime);
  const sentinel = 'api_key=SYNTHETIC_PRIVATE_CLIENT_VALUE';
  let fault = '';
  const client: EditorClient = {
    ...raw,
    command(name, input, options) {
      return name === fault ? Promise.reject(Error(sentinel)) : raw.command(name, input, options);
    },
  };
  const editor = await acquireEditor(runtime, { client, clientId: 'raw-client-errors' });
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
    await runtime.runPromise(TestClock.adjust('120 millis'));
    await complete;
    assert(lookup.getSnapshot().message.includes('Application effect failed'));
    assert(!JSON.stringify(lookup.getSnapshot()).includes(sentinel));
    await lookup.dispose();
    fault = 'inspectEntries';
    const mutation = editor.createMutation({ checkout, kind: 'move', paths: ['a.ts'] });
    assert.equal(await mutation.apply('moved.ts', '', false), false);
    assert.equal(mutation.getSnapshot().error, 'Application effect failed');
    assert(!JSON.stringify(mutation.getSnapshot()).includes(sentinel));
    await mutation.dispose();
  } finally {
    await editor.dispose();
    await runtime.dispose();
  }
});

for (const outcome of ['success', 'held-failure', 'throw'] as const)
  test(`reentrant watch disposal owns the returned handle and acquisition outcome (${outcome})`, async () => {
    const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'A' } }]);
    const runtime = ManagedRuntime.make(memory.layer),
      raw = makeEditorClient(runtime);
    const entered = gate(),
      release = gate();
    // A failure the editor reports (an Unavailable one is watched again first).
    const trigger = new ApplicationError({
      code: 'Incompatible',
      message: 'Reentrant observation disposal',
    });
    const failure = new ApplicationError({
      code: 'Persistence',
      message: 'Reentrant observation release failed',
    });
    let releases = 0,
      disposing: Promise<void> | undefined,
      settled = false;
    let late!: (event: WorkspaceEvent) => void;
    const state = {
      ...emptyRecovery('reentrant-watch'),
      checkouts: [checkout],
      openCheckoutIds: [checkout.checkoutId],
      selectedCheckoutId: checkout.checkoutId,
    };
    const client: EditorClient = {
      ...raw,
      async command(name, input, options) {
        if (name === 'loadRecovery') return { revision: 0, state, errors: [], operations: [] };
        return raw.command(name, input, options);
      },
      watch(input, receive, onError) {
        late = receive;
        if (outcome === 'throw') {
          onError(trigger);
          throw failure;
        }
        const close = raw.watch(input, receive, onError);
        onError(trigger);
        let completion: Promise<void> | undefined;
        return () =>
          (completion ??= (async () => {
            releases++;
            await close();
            entered.release();
            if (outcome === 'held-failure') {
              await release.promise;
              throw failure;
            }
          })());
      },
    };
    const editor = await acquireEditor(runtime, { client, clientId: state.clientId });
    const off = editor.subscribe(() => {
      if (!disposing && editor.getSnapshot().errors.includes(trigger.message)) {
        disposing = editor.dispose();
        void disposing.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
      }
    });
    const loading = editor.load().catch(() => {});
    try {
      if (outcome !== 'throw') await entered.promise;
      else await loading;
      assert(disposing);
      assert.strictEqual(editor.dispose(), disposing);
      if (outcome === 'held-failure') {
        const snapshot = editor.getSnapshot();
        assert.equal(snapshot.disposed, false);
        assert.equal(settled, false);
        late({ checkout, paths: ['a.ts'], error: 'Late observation callback' });
        assert.strictEqual(editor.getSnapshot(), snapshot);
        release.release();
      }
      if (outcome === 'success') {
        await disposing;
        assert.equal(editor.getSnapshot().disposed, true);
      } else {
        await assert.rejects(disposing, (error) => error === failure);
        assert.equal(editor.getSnapshot().disposed, false);
        await assert.rejects(editor.dispose(), (error) => error === failure);
      }
      await loading;
      assert.equal(releases, outcome === 'throw' ? 0 : 1);
      assert.equal(memory.stats.active, 0);
      assert.equal(memory.stats.publications, 0);
    } finally {
      off();
      release.release();
      await loading;
      await editor.dispose().catch(() => {});
      await runtime.dispose();
    }
  });
