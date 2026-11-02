import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Effect, Exit, ManagedRuntime, Scope } from 'effect';
import { ApplicationError, emptyRecovery, type EditorClient } from '@moonbase/contracts/workspace';
import { runApplicationEffect } from '@moonbase/application/runtime/effect-client';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import { makeEditorModel, makeEditorController } from '@moonbase/application/editor';
import { WorkspaceLive } from '@moonbase/workspace';

const persistence = (error: unknown) => ApplicationError.is(error) && error.code === 'Persistence';

test('real prior-producer recovery with an unfamiliar nested draft field rejects before editor capture and retains original rows across reopen', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moonbase-strict-recovery-'))),
    root = join(base, 'repo'),
    dataDirectory = join(base, 'state');
  mkdirSync(root);
  execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', root]);
  writeFileSync(join(root, 'file.txt'), 'original disk');
  const start = () => ManagedRuntime.make(WorkspaceLive({ hostId: 'strict-local', dataDirectory }));
  let runtime = start();
  const scope = Scope.makeUnsafe();
  let controller: ReturnType<typeof makeEditorController> | undefined;
  try {
    let client = makeEditorClient(runtime);
    const checkout = await client.command('openCheckout', { root }),
      target = { checkout, path: 'file.txt' },
      disk = await client.command('readFile', target);
    const state = {
      ...emptyRecovery('strict-editor'),
      checkouts: [checkout],
      openCheckoutIds: [checkout.checkoutId],
      selectedCheckoutId: checkout.checkoutId,
      drafts: [{ target, text: 'irreplaceable saved draft', disk }],
      views: {
        [checkout.checkoutId]: {
          openFiles: ['file.txt'],
          active: 'file.txt',
          preview: null,
          fileViews: { 'file.txt': 'file' as const },
          positions: { 'file.txt': { 'file:original': { line: 1, column: 2, top: 3, left: 4 } } },
          tree: {
            expanded: [''],
            selected: ['file.txt'],
            focus: 'file.txt',
            scroll: 5,
            hideIgnored: true,
          },
        },
      },
    };
    await client.command('persistRecovery', {
      clientId: state.clientId,
      requestId: 'known-producer',
      expectedRevision: 0,
      state,
    });
    assert.deepEqual(
      (await client.command('loadRecovery', { clientId: state.clientId })).state,
      state,
    );
    await runtime.dispose();
    runtime = start();
    client = makeEditorClient(runtime);
    assert.deepEqual(
      (await client.command('loadRecovery', { clientId: state.clientId })).state,
      state,
      'recognized optional positions survive an unchanged reopen',
    );
    const database = new DatabaseSync(join(dataDirectory, 'moonbase-workspace-v1.sqlite'));
    try {
      // Explicit prior-producer bytes bypass the current strict public producer on purpose.
      const prior = {
        ...state,
        drafts: [{ ...state.drafts[0], futureMetadata: { note: 'retain original evidence' } }],
      };
      const original = JSON.stringify(prior);
      database.prepare('UPDATE recovery SET body=? WHERE client=?').run(original, state.clientId);
      const before = database.prepare('SELECT client,revision,body FROM recovery').all();
      const records = database
        .prepare('SELECT bucket,key,body FROM records ORDER BY bucket,key')
        .all();
      let publications = 0,
        mutations = 0;
      const observed: EditorClient = {
        watch: client.watch,
        command(name, input, options) {
          if (name === 'persistRecovery') publications++;
          if (name === 'saveFile' || name === 'mutate') mutations++;
          return client.command(name, input, options);
        },
      };
      const model = await runApplicationEffect(
        runtime,
        makeEditorModel({ client: observed, clientId: state.clientId }).pipe(
          Effect.provideService(Scope.Scope, scope),
        ),
      );
      controller = makeEditorController(runtime, model);
      await assert.rejects(controller.load(), persistence);
      assert.equal(controller.getSnapshot().ready, false);
      assert.equal(controller.getSnapshot().recoveryReady, false);
      assert.throws(() => controller!.edit(target, 'new live text'), /Load editor recovery/);
      await assert.rejects(controller.flush(), /Load editor recovery/);
      assert.equal(publications, 0);
      assert.equal(mutations, 0);
      await assert.rejects(
        client.command('persistRecovery', {
          clientId: state.clientId,
          requestId: 'overwrite',
          expectedRevision: 1,
          state,
        }),
        persistence,
      );
      assert.deepEqual(database.prepare('SELECT client,revision,body FROM recovery').all(), before);
      assert.deepEqual(
        database.prepare('SELECT bucket,key,body FROM records ORDER BY bucket,key').all(),
        records,
      );
      assert.equal(readFileSync(join(root, 'file.txt'), 'utf8'), 'original disk');
      await controller.dispose();
      await runApplicationEffect(runtime, Scope.close(scope, Exit.void));
      await runtime.dispose();
      runtime = start();
      await assert.rejects(
        makeEditorClient(runtime).command('loadRecovery', { clientId: state.clientId }),
        persistence,
      );
      assert.deepEqual(database.prepare('SELECT client,revision,body FROM recovery').all(), before);
    } finally {
      database.close();
    }
  } finally {
    if (controller) await controller.dispose();
    await runApplicationEffect(runtime, Scope.close(scope, Exit.void));
    await runtime.dispose();
    rmSync(base, { recursive: true, force: true });
  }
});
