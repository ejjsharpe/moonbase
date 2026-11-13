import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ManagedRuntime } from 'effect';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import { emptyRecovery } from '@moonbase/contracts/workspace';
import { WorkspaceLive } from '../../test/fixtures/workspace-live.ts';

import { fixture, rejects, draft } from '../../test/fixtures/workspace-fixture.ts';
test('public client saves, rejects changed retries and preserves original dirty conflict baselines across restart', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'file.txt'), 'original');
    const checkout = await f.client.command('openCheckout', { root: f.root }),
      target = { checkout, path: 'file.txt' };
    const disk = await f.client.command('readFile', target);
    await f.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'alice',
      expectedRevision: 0,
      state: draft('alice', checkout, 'dirty text', disk),
    });
    writeFileSync(join(f.root, 'file.txt'), 'external');
    const input = {
      target,
      clientId: 'alice',
      requestId: 'save-1',
      text: 'dirty text',
      expectedVersion: disk.version,
    };
    const conflict = await f.client.command('saveFile', input);
    assert.equal(conflict.kind, 'conflict');
    assert.equal(
      (await f.client.command('loadRecovery', { clientId: 'alice' })).state.drafts[0].disk.text,
      'original',
    );
    await assert.rejects(
      f.client.command('saveFile', { ...input, text: 'changed retry' }),
      rejects('Conflict'),
    );
    assert.deepEqual(await f.client.command('saveFile', input), conflict);
    assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), 'external');
    assert.equal(
      (
        await f.client.command('saveFile', {
          ...input,
          requestId: 'deliberate-overwrite',
          expectedVersion: conflict.disk.version,
        })
      ).kind,
      'saved',
    );
    await f.runtime.dispose();
    const restarted = f.start();
    try {
      const state = await restarted.client.command('loadRecovery', { clientId: 'alice' });
      assert.equal(state.state.drafts[0].text, 'dirty text');
      assert.equal(state.state.drafts[0].disk.text, 'dirty text');
      assert.equal((await restarted.client.command('readFile', target)).text, 'dirty text');
      assert.deepEqual(await restarted.client.command('saveFile', input), conflict);
    } finally {
      await restarted.runtime.dispose();
    }
  } finally {
    await f.close();
  }
});

test('independent clients and compare-and-swap recovery do not overwrite one another; invalid baselines fail', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'file.txt'), 'disk');
    const checkout = await f.client.command('openCheckout', { root: f.root }),
      disk = await f.client.command('readFile', { checkout, path: 'file.txt' });
    await f.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'alice',
      expectedRevision: 0,
      state: draft('alice', checkout, 'alice edit', disk),
    });
    await f.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'bob',
      expectedRevision: 0,
      state: draft('bob', checkout, 'bob edit', disk),
    });
    await assert.rejects(
      f.client.command('persistRecovery', {
        requestId: randomUUID(),
        clientId: 'alice',
        expectedRevision: 0,
        state: emptyRecovery('alice'),
      }),
      rejects('Conflict'),
    );
    assert.equal(
      (await f.client.command('loadRecovery', { clientId: 'bob' })).state.drafts[0].text,
      'bob edit',
    );
    const bad = draft('alice', checkout, 'safe', { ...disk, version: 'wrong' });
    await assert.rejects(
      f.client.command('persistRecovery', {
        requestId: randomUUID(),
        clientId: 'alice',
        expectedRevision: 1,
        state: bad,
      }),
      rejects('InvalidInput'),
    );
  } finally {
    await f.close();
  }
});

test('one client Save never rebases another client dirty baseline, including restart and newer-revision stale publication', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'file.txt'), 'original');
    const checkout = await f.client.command('openCheckout', { root: f.root }),
      target = { checkout, path: 'file.txt' },
      disk = await f.client.command('readFile', target);
    for (const clientId of ['alice', 'bob'])
      await f.client.command('persistRecovery', {
        requestId: randomUUID(),
        clientId,
        expectedRevision: 0,
        state: draft(clientId, checkout, 'same dirty text', disk),
      });
    await f.client.command('saveFile', {
      target,
      clientId: 'alice',
      requestId: 'own-save',
      text: 'same dirty text',
      expectedVersion: disk.version,
    });
    const bob = await f.client.command('loadRecovery', { clientId: 'bob' });
    assert.deepEqual(bob.state.drafts[0].disk, disk);
    assert.equal(bob.revision, 1);
    const newer = structuredClone(bob.state);
    newer.drafts[0].text = 'newer bob edit';
    await f.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'bob',
      expectedRevision: 1,
      state: newer,
    });
    await assert.rejects(
      f.client.command('persistRecovery', {
        requestId: randomUUID(),
        clientId: 'bob',
        expectedRevision: 1,
        state: bob.state,
      }),
      rejects('Conflict'),
    );
    await f.runtime.dispose();
    const restarted = f.start();
    try {
      const restored = await restarted.client.command('loadRecovery', { clientId: 'bob' });
      assert.equal(restored.state.drafts[0].text, 'newer bob edit');
      assert.deepEqual(restored.state.drafts[0].disk, disk);
      const result = await restarted.client.command('saveFile', {
        target,
        clientId: 'bob',
        requestId: 'bob-save',
        text: 'newer bob edit',
        expectedVersion: restored.state.drafts[0].disk.version,
      });
      assert.equal(result.kind, 'conflict');
      assert.equal(result.disk.text, 'same dirty text');
      assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), 'same dirty text');
    } finally {
      await restarted.runtime.dispose();
    }
  } finally {
    await f.close();
  }
});

for (const kind of ['save', 'move'] as const)
  test(`own ${kind} receipt exposes a competing same-client publication gap and retry does not write again`, async () => {
    const { fileURLToPath } = await import('node:url');
    const f = fixture(),
      helper = join(f.base, 'pause-effect'),
      ready = join(f.base, 'effect-ready'),
      release = join(f.base, 'effect-release'),
      count = join(f.base, 'effect-count');
    const binary = fileURLToPath(new URL('../../dist/filesystem', import.meta.url)),
      operationName = kind === 'save' ? 'replace' : 'move';
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    writeFileSync(
      helper,
      `#!/bin/sh\nif [ "$1" = ${quote(operationName)} ]; then\n printf 'called\\n' >> ${quote(count)}\n /usr/bin/touch ${quote(ready)}\n while [ ! -e ${quote(release)} ]; do /bin/sleep 0.01; done\nfi\nexec ${quote(binary)} "$@"\n`,
    );
    chmodSync(helper, 0o700);
    const runtime = ManagedRuntime.make(
        WorkspaceLive({
          dataDirectory: f.dataDirectory,
          hostId: 'local-test',
          filesystemHelper: helper,
        }),
      ),
      client = makeEditorClient(runtime);
    try {
      writeFileSync(join(f.root, 'file.txt'), 'original');
      const checkout = await client.command('openCheckout', { root: f.root }),
        target = { checkout, path: 'file.txt' };
      const disk = await client.command('readFile', target),
        initial = draft('alice', checkout, 'captured local edit', disk);
      await client.command('persistRecovery', {
        requestId: randomUUID(),
        clientId: 'alice',
        expectedRevision: 0,
        state: initial,
      });
      const sources = await client.command('inspectEntries', { checkout, paths: ['file.txt'] });
      const operation = {
          id: 'gap',
          clientId: 'alice',
          checkout,
          kind: 'move' as const,
          sources,
          destination: 'moved.txt',
        },
        save = {
          target,
          clientId: 'alice',
          requestId: 'gap',
          text: 'captured local edit',
          expectedVersion: disk.version,
        };
      const pending =
        kind === 'save' ? client.command('saveFile', save) : client.command('mutate', operation);
      const deadline = Date.now() + 3000;
      while (!existsSync(ready)) {
        assert(Date.now() < deadline);
        await new Promise((r) => setTimeout(r, 10));
      }
      const competing = structuredClone(initial);
      competing.drafts[0].text = 'newer competing client edit';
      await client.command('persistRecovery', {
        requestId: randomUUID(),
        clientId: 'alice',
        expectedRevision: 1,
        state: competing,
      });
      writeFileSync(release, 'resume');
      const result = await pending;
      assert('recoveryChanges' in result);
      assert.deepEqual(result.recoveryChanges, [
        { clientId: 'alice', previousRevision: 2, revision: 3 },
      ]);
      // A controller still at revision 1 cannot advance along the receipt beginning at 2.
      assert.notEqual(result.recoveryChanges[0].previousRevision, 1);
      await assert.rejects(
        client.command('persistRecovery', {
          requestId: randomUUID(),
          clientId: 'alice',
          expectedRevision: 1,
          state: initial,
        }),
        rejects('Conflict'),
      );
      const retained = await client.command('loadRecovery', { clientId: 'alice' });
      assert.equal(retained.revision, 3);
      assert.equal(retained.state.drafts[0].text, 'newer competing client edit');
      const again =
        kind === 'save'
          ? await client.command('saveFile', save)
          : await client.command('mutate', operation);
      assert.deepEqual(again, result);
      assert.equal((await client.command('loadRecovery', { clientId: 'alice' })).revision, 3);
      assert.equal(readFileSync(count, 'utf8'), 'called\n');
    } finally {
      writeFileSync(release, 'resume');
      await runtime.dispose();
      await f.close();
    }
  });

test('save rejects a replaced staging object and never publishes or removes the impostor', async () => {
  const { fileURLToPath } = await import('node:url');
  const f = fixture(),
    helper = join(f.base, 'swap-save-stage'),
    stageRecord = join(f.base, 'stage-path');
  const binary = fileURLToPath(new URL('../../dist/filesystem', import.meta.url));
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  writeFileSync(
    helper,
    `#!/bin/sh\nif [ "$1" = stage ]; then\n ${quote(binary)} "$@" || exit $?\n stage=${quote(f.root + '/')}"$3"\n printf '%s' "$stage" > ${quote(stageRecord)}\n /bin/mv "$stage" "$stage-retained"\n printf 'impostor bytes' > "$stage"\n exit 0\nfi\nexec ${quote(binary)} "$@"\n`,
  );
  chmodSync(helper, 0o700);
  const runtime = ManagedRuntime.make(
      WorkspaceLive({
        dataDirectory: f.dataDirectory,
        hostId: 'local-test',
        filesystemHelper: helper,
      }),
    ),
    client = makeEditorClient(runtime);
  try {
    writeFileSync(join(f.root, 'file.txt'), 'original');
    const checkout = await client.command('openCheckout', { root: f.root }),
      target = { checkout, path: 'file.txt' },
      disk = await client.command('readFile', target);
    await assert.rejects(
      client.command('saveFile', {
        target,
        clientId: 'alice',
        requestId: 'stage-swap',
        text: 'intended bytes',
        expectedVersion: disk.version,
      }),
      rejects('Uncertain'),
    );
    const stage = readFileSync(stageRecord, 'utf8');
    assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), 'original');
    assert.equal(readFileSync(stage, 'utf8'), 'impostor bytes');
    assert.equal(readFileSync(stage + '-retained', 'utf8'), 'intended bytes');
  } finally {
    await runtime.dispose();
    await f.close();
  }
});

test('restart recovers the admitted Save text even when no earlier draft publication existed', async () => {
  const { fileURLToPath } = await import('node:url');
  const f = fixture(),
    helper = join(f.base, 'interrupt-save');
  const binary = fileURLToPath(new URL('../../dist/filesystem', import.meta.url));
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  writeFileSync(
    helper,
    `#!/bin/sh\nif [ "$1" = stage ]; then kill -KILL $$; fi\nexec ${quote(binary)} "$@"\n`,
  );
  chmodSync(helper, 0o700);
  const runtime = ManagedRuntime.make(
      WorkspaceLive({
        dataDirectory: f.dataDirectory,
        hostId: 'local-test',
        filesystemHelper: helper,
      }),
    ),
    client = makeEditorClient(runtime);
  try {
    writeFileSync(join(f.root, 'file.txt'), 'original');
    const checkout = await client.command('openCheckout', { root: f.root }),
      target = { checkout, path: 'file.txt' },
      disk = await client.command('readFile', target);
    const save = {
      target,
      clientId: 'alice',
      requestId: 'interrupted-save',
      text: 'admitted unsaved text',
      expectedVersion: disk.version,
    };
    await assert.rejects(client.command('saveFile', save), rejects('Uncertain'));
    await runtime.dispose();
    const restarted = f.start();
    try {
      const restored = await restarted.client.command('loadRecovery', { clientId: 'alice' });
      assert.equal(restored.state.drafts[0].text, 'admitted unsaved text');
      assert.deepEqual(restored.state.drafts[0].disk, disk);
      assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), 'original');
      // A repeat asks the host, which finds the file as it was: the save settles as a conflict
      // with the restored text kept, in this session rather than after another load.
      assert.equal((await restarted.client.command('saveFile', save)).kind, 'conflict');
      const settled = await restarted.client.command('loadRecovery', { clientId: 'alice' });
      assert.equal(settled.revision, restored.revision);
      assert.equal(settled.state.drafts[0].text, 'admitted unsaved text');
      assert.deepEqual(settled.errors, []);
    } finally {
      await restarted.runtime.dispose();
    }
  } finally {
    await runtime.dispose();
    await f.close();
  }
});
