import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ManagedRuntime } from 'effect';
import { ApplicationError } from '@moonbase/contracts/workspace';
import {
  toWorkspaceClient as makeEditorClient,
  type WorkspaceClient,
} from '@moonbase/application/testing/editor-fixture';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';
import { acquireEditor, checkout, target, fixture, held as gate } from '../editor-fixture.ts';

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

test('a reported string shows as written, and an unknown error only as a generic failure', async () => {
  const f = await fixture('reported-errors', false);
  try {
    f.editor.report('Can’t move a folder into itself.');
    f.editor.report(new Error('/private/path'));
    const [own, unknown] = f.editor.getSnapshot().errors;
    assert.equal(own, 'Can’t move a folder into itself.');
    assert.doesNotMatch(unknown, /private/);
  } finally {
    await f.dispose();
  }
});
