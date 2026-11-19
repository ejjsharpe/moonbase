import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, ManagedRuntime } from 'effect';
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

test('closing the editor interrupts a load and a save in flight and releases its watches, keeping the draft and the process runtime', async () => {
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
  try {
    await f.editor.open(target('a.ts'));
    f.editor.edit(target('a.ts'), 'recover me');
    await f.editor.flush();
    await f.editor.dispose();

    const loading = await acquire();
    const load = h.hold('loadRecovery');
    const loaded = loading.load();
    await load.entered;
    await loading.dispose();
    await assert.rejects(loaded, closed);
    load.release();

    const editor = await acquire();
    await editor.load();
    assert.equal(recoveryWatches, 1);
    const save = h.hold('saveFile');
    const saved = editor.save(target('a.ts'));
    await save.entered;
    // Closing the session, before its layers are released, ends the save and every watch.
    await editor.runtime.runPromise(Effect.flatMap(Effect.service(EditorSession), (s) => s.close));
    await assert.rejects(saved, closed);
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
    for (const editor of editors) await editor.dispose();
    await f.dispose();
  }
});
