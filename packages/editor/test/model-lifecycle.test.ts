import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Exit, ManagedRuntime, Scope } from 'effect';
import {
  ApplicationError,
  emptyRecovery,
  type EditorClient,
  type RecoveryLoad,
  type WorkspaceEvent,
} from '@moonbase/application/client';
import { makeEditorClient } from '@moonbase/application/runtime-client';
import { makeEditorController, makeEditorModel } from '@moonbase/editor/state';
import { memoryWorkspace } from '@moonbase/editor/memory';
import { acquireEditor } from './model-fixture.ts';
import { checkout, target } from './editor-fixture.ts';

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

test('one acquired model binds once; two models share one runtime and failed held cleanup stays pending and observable', async () => {
  const memory = memoryWorkspace([{ checkout, files: { 'a.ts': 'A' } }]);
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
  const memory = memoryWorkspace([{ checkout, files: { 'a.ts': 'A' } }]);
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
  const memory = memoryWorkspace([{ checkout, files: { 'a.ts': 'A' } }]);
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
  const memory = memoryWorkspace([{ checkout, files: { 'a.ts': 'A', 'b.ts': 'B' } }]);
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

test('dismissing inspection admits no mutation; dismissing after dispatch retains model-owned outcome exactly once', async () => {
  const memory = memoryWorkspace([{ checkout, files: { 'a.ts': 'A' } }]);
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
