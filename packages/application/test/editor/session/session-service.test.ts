import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Ref, Scope } from 'effect';
import type { WorkspaceEvent } from '@moonbase/contracts/workspace';
import {
  toWorkspaceClient as makeEditorClient,
  type WorkspaceClient,
} from '@moonbase/application/testing/editor-fixture';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';
import { EditorError, EditorSession } from '@moonbase/application/editor';
import {
  acquireEditor,
  checkout,
  target,
  fixture,
  held,
  holding,
  loadStoredState,
  draftsOf,
  type EditorDriver,
} from '../editor-fixture.ts';

test('two editors share one workspace, and a disposed editor admits and sends nothing', async () => {
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

test('closing the editor interrupts a load and a save in flight and releases its watches once its finalizers finish, keeping the draft and the process runtime', async () => {
  const f = await fixture();
  const h = holding(f.client);
  let recoveryWatches = 0;
  const client: WorkspaceClient = {
    ...h.client,
    watchRecovery(input, receive, onError) {
      recoveryWatches++;
      const close = h.client.watchRecovery(input, receive, onError);
      return async () => {
        recoveryWatches--;
        await close();
      };
    },
  };
  const editors: EditorDriver[] = [];
  const acquire = async () => {
    const editor = await acquireEditor(f.runtime, { client, clientId: f.editor.clientId });
    editors.push(editor);
    return editor;
  };
  const closed = (error: unknown) => error instanceof EditorError && error.reason === 'closed';
  const finalizer = held();
  const sessionOf = (editor: EditorDriver) =>
    editor.runtime.runPromise(Effect.service(EditorSession));
  try {
    await f.editor.open(target('a.ts'));
    f.editor.edit(target('a.ts'), 'recover me');
    await f.editor.flush();
    await f.editor.dispose();

    const loading = await acquire();
    const load = h.hold('loadRecovery');
    const loaded = loading.load();
    await load.entered;
    await loading.runtime.runPromise((await sessionOf(loading)).close);
    await assert.rejects(loaded, closed);
    load.release();

    const editor = await acquire();
    await editor.load();
    assert.equal(recoveryWatches, 1);
    assert.equal(f.memory.stats.active, 1);
    const save = h.hold('saveFile');
    const saved = assert.rejects(editor.save(target('a.ts')), closed);
    await save.entered;
    // A finalizer the session owns holds its close open.
    const session = await sessionOf(editor);
    const finalizing = held();
    await editor.runtime.runPromise(
      Scope.addFinalizer(
        session.scope,
        Effect.promise(() => {
          finalizing.release();
          return finalizer.promise;
        }),
      ),
    );
    // Closing the session, before its layers are released, ends the save and every watch. A
    // second close waits for the first to finish.
    const settled: string[] = [];
    const closing = editor.runtime.runPromise(session.close).then(() => settled.push('first'));
    await finalizing.promise;
    const again = editor.runtime.runPromise(session.close).then(() => settled.push('second'));
    for (let turn = 0; turn < 10; turn++) await f.runtime.runPromise(Effect.yieldNow);
    assert.deepEqual(settled, []);
    finalizer.release();
    await Promise.all([closing, again, saved]);
    assert.equal(recoveryWatches, 0);
    assert.equal(f.memory.stats.active, 0);
    save.release();
    await f.runtime.runPromise(Effect.yieldNow);
    // The editor stopped waiting; whatever the host made of the save, the draft is still kept.
    assert.deepEqual(
      draftsOf(await loadStoredState(f.client, f.editor.clientId)).map((d) => d.text),
      ['recover me'],
    );
    await editor.dispose();
    assert.equal(f.memory.stats.subscriptions, f.memory.stats.released);
  } finally {
    finalizer.release();
    for (const editor of editors) await editor.dispose();
    await f.dispose();
  }
});

test('work run for its caller is abandoned when the caller is interrupted as the work starts', async () => {
  const program = Effect.gen(function* () {
    const session = yield* EditorSession;
    const gate = yield* Deferred.make<void>();
    const applied = yield* Ref.make(false);
    let work!: Fiber.Fiber<void>;
    const caller = yield* Effect.forkChild(
      Effect.withFiber((self) =>
        session.runWithCaller(
          Effect.withFiber((child) => {
            work = child as Fiber.Fiber<void>;
            // The caller is interrupted before it can wait on the work it just started.
            self.interruptUnsafe();
            return Effect.andThen(Deferred.await(gate), Ref.set(applied, true));
          }),
        ),
      ),
      { startImmediately: true },
    );
    const callerExit = yield* Fiber.await(caller);
    yield* Deferred.succeed(gate, undefined);
    const workExit = yield* Fiber.await(work);
    return { callerExit, workExit, applied: yield* Ref.get(applied) };
  });
  const { callerExit, workExit, applied } = await Effect.runPromise(
    Effect.provide(program, Layer.fresh(EditorSession.layer({ clientId: 'caller' }))),
  );
  assert.ok(Exit.hasInterrupts(callerExit));
  assert.ok(Exit.hasInterrupts(workExit));
  assert.equal(applied, false);
});
