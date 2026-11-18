import { checkout, fixture, loadStoredState } from '../editor/editor-fixture.ts';
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { ManagedRuntime } from 'effect';
import { toWorkspaceClient as makeEditorClient } from '@moonbase/application/testing/editor-fixture';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';
import { checkoutKey } from '@moonbase/application/editor';

describe('prototype-shaped filenames', () => {
  const checkout = {
    hostId: 'local',
    checkoutId: 'filenames',
    projectId: 'project',
    root: '/memory/filenames',
    vcs: 'git' as const,
    branch: 'main',
    worktree: 'main' as 'main' | 'linked',
  };

  const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];

  const target = (path: string) => ({ checkout, path });

  test('untracked prototype-shaped filenames never inherit a demo Git baseline', async () => {
    const memory = fauxWorkspace([
      {
        checkout,
        files: Object.fromEntries(names.map((path) => [path, 'working'])),
        head: {},
        index: {},
      },
    ]);
    const runtime = ManagedRuntime.make(memory.layer),
      client = makeEditorClient(runtime);
    try {
      assert.deepEqual(
        (await client.command('gitStatus', { checkout })).changes.map((change) => [
          change.path,
          change.area,
        ]),
        names.map((path) => [path, 'untracked']),
      );
      for (const path of names) {
        for (const area of ['staged', 'unstaged'] as const)
          await assert.rejects(client.command('readComparison', { target: target(path), area }), {
            _tag: 'WorkspaceUnavailableError',
          });
        assert.equal(
          (await client.command('readComparison', { target: target(path), area: 'untracked' }))
            .original,
          '',
        );
      }
    } finally {
      await runtime.dispose();
    }
  });
});

test('the memory store refuses a layout with composite view keys or invalid open membership', async () => {
  const f = await fixture('schema', false);
  try {
    await f.editor.flush();
    const {
      buffers: _,
      version: _version,
      clientId: _clientId,
      ...layout
    } = await loadStoredState(f.client, f.editor.clientId);
    const selected = layout.views[checkout.checkoutId];
    assert(selected);
    const edits = f.memory.stats.edits;
    await assert.rejects(
      f.client.command('updateLayout', {
        clientId: f.editor.clientId,
        layout: { ...layout, views: { [checkoutKey(checkout)]: selected } },
      }),
    );
    for (const openCheckoutIds of [['not-known'], [checkout.checkoutId, checkout.checkoutId], []])
      await assert.rejects(
        f.client.command('updateLayout', {
          clientId: f.editor.clientId,
          layout: { ...layout, openCheckoutIds },
        }),
      );
    assert.equal(f.memory.stats.edits, edits);
  } finally {
    await f.dispose();
  }
});
