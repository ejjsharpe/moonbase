import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, ManagedRuntime } from 'effect';
import type { WorkspaceEvent } from '@moonbase/contracts/workspace';
import {
  toWorkspaceClient as makeEditorClient,
  type WorkspaceClient,
} from '@moonbase/application/testing/editor-fixture';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';
import {
  acquireEditor,
  checkout,
  target,
  fixture,
  loadStoredState,
  draftsOf,
} from '../editor-fixture.ts';

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

test('disposal releases view subscriptions without discarding a kept draft or ending the process runtime', async () => {
  const f = await fixture();
  try {
    await f.editor.open(target('a.ts'));
    f.editor.edit(target('a.ts'), 'recover me');
    await f.editor.flush();
    await f.editor.dispose();
    await f.runtime.runPromise(Effect.yieldNow);
    assert.equal(f.memory.stats.active, 0);
    assert.equal(f.memory.stats.subscriptions, f.memory.stats.released);
    assert.deepEqual(
      draftsOf(await loadStoredState(f.client, f.editor.clientId)).map((d) => d.text),
      ['recover me'],
    );
    assert.equal((await f.client.command('readFile', target('b.ts'))).text, 'second');
    await assert.rejects(f.editor.open(target('b.ts')), /disposed/);
  } finally {
    await f.dispose();
  }
});
