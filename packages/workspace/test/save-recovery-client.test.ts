import { isConflict, isRefusal, isUncertain } from '@moonbase/contracts/error-groups';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ManagedRuntime } from 'effect';
import { makeWorkspaceClient } from './workspace-client-fixture.ts';
import { WorkspaceLive } from './workspace-live-fixture.ts';
import { fixture } from './workspace-fixture.ts';
import { draftsOf, seed } from './recovery-fixture.ts';

const bufferId = 'file';
test('public client saves, rejects changed retries and preserves original dirty conflict baselines across restart', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'file.txt'), 'original');
    const checkout = await f.client.command('openCheckout', { root: f.root }),
      target = { checkout, path: 'file.txt' };
    const disk = await f.client.command('readFile', target);
    await seed(f.client, 'alice', [{ target, text: 'dirty text', disk, bufferId }]);
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
      draftsOf((await f.client.command('loadRecovery', { clientId: 'alice' })).state)[0]?.disk.text,
      'original',
    );
    await assert.rejects(
      f.client.command('saveFile', { ...input, text: 'changed retry' }),
      isConflict,
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
      const [restored] = draftsOf(
        (await restarted.client.command('loadRecovery', { clientId: 'alice' })).state,
      );
      assert.equal(restored?.text, 'dirty text');
      assert.equal(restored?.disk.text, 'dirty text');
      assert.equal((await restarted.client.command('readFile', target)).text, 'dirty text');
      assert.deepEqual(await restarted.client.command('saveFile', input), conflict);
    } finally {
      await restarted.runtime.dispose();
    }
  } finally {
    await f.close();
  }
});

test("independent clients' recoveries do not overwrite one another; an invalid baseline fails", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'file.txt'), 'disk');
    const checkout = await f.client.command('openCheckout', { root: f.root }),
      target = { checkout, path: 'file.txt' },
      disk = await f.client.command('readFile', target);
    await seed(f.client, 'alice', [{ target, text: 'alice edit', disk, bufferId }]);
    await seed(f.client, 'bob', [{ target, text: 'bob edit', disk, bufferId }]);
    await f.client.command('closeTab', {
      clientId: 'alice',
      bufferId,
      discard: true,
    });
    assert.deepEqual(
      draftsOf((await f.client.command('loadRecovery', { clientId: 'bob' })).state).map(
        (d) => d.text,
      ),
      ['bob edit'],
    );
    await f.client.command('openTab', { clientId: 'alice', bufferId: 'b', target });
    await assert.rejects(
      f.client.command('updateDraft', {
        clientId: 'alice',
        bufferId: 'b',
        text: 'safe',
        disk: { ...disk, version: 'wrong' },
      }),
      isRefusal,
    );
  } finally {
    await f.close();
  }
});

test('one client Save never rebases another client dirty baseline, including restart', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'file.txt'), 'original');
    const checkout = await f.client.command('openCheckout', { root: f.root }),
      target = { checkout, path: 'file.txt' },
      disk = await f.client.command('readFile', target);
    for (const clientId of ['alice', 'bob'])
      await seed(f.client, clientId, [{ target, text: 'same dirty text', disk, bufferId }]);
    await f.client.command('saveFile', {
      target,
      clientId: 'alice',
      requestId: 'own-save',
      text: 'same dirty text',
      expectedVersion: disk.version,
    });
    const bob = await f.client.command('loadRecovery', { clientId: 'bob' });
    assert.deepEqual(draftsOf(bob.state)[0]?.disk, disk);
    await f.client.command('updateDraft', {
      clientId: 'bob',
      bufferId,
      text: 'newer bob edit',
      disk,
    });
    await f.runtime.dispose();
    const restarted = f.start();
    try {
      const [restored] = draftsOf(
        (await restarted.client.command('loadRecovery', { clientId: 'bob' })).state,
      );
      assert.equal(restored?.text, 'newer bob edit');
      assert.deepEqual(restored?.disk, disk);
      const result = await restarted.client.command('saveFile', {
        target,
        clientId: 'bob',
        requestId: 'bob-save',
        text: 'newer bob edit',
        expectedVersion: disk.version,
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
  test(`own ${kind} keeps a same-client edit made while it ran, and a retry does not write again`, async () => {
    const { fileURLToPath } = await import('node:url');
    const f = fixture(),
      helper = join(f.base, 'pause-effect'),
      ready = join(f.base, 'effect-ready'),
      release = join(f.base, 'effect-release'),
      count = join(f.base, 'effect-count');
    const binary = fileURLToPath(new URL('../dist/filesystem', import.meta.url)),
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
      client = makeWorkspaceClient(runtime);
    try {
      writeFileSync(join(f.root, 'file.txt'), 'original');
      const checkout = await client.command('openCheckout', { root: f.root }),
        target = { checkout, path: 'file.txt' };
      const disk = await client.command('readFile', target);
      await seed(client, 'alice', [{ target, text: 'captured local edit', disk, bufferId }]);
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
      await client.command('updateDraft', {
        clientId: 'alice',
        bufferId,
        text: 'newer competing client edit',
        disk,
      });
      writeFileSync(release, 'resume');
      const result = await pending;
      const retained = await client.command('loadRecovery', { clientId: 'alice' });
      assert.deepEqual(
        draftsOf(retained.state).map((d) => d.text),
        ['newer competing client edit'],
      );
      const again =
        kind === 'save'
          ? await client.command('saveFile', save)
          : await client.command('mutate', operation);
      assert.deepEqual(again, result);
      assert.deepEqual(await client.command('loadRecovery', { clientId: 'alice' }), retained);
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
  const binary = fileURLToPath(new URL('../dist/filesystem', import.meta.url));
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
    client = makeWorkspaceClient(runtime);
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
      isUncertain,
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
  const binary = fileURLToPath(new URL('../dist/filesystem', import.meta.url));
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
    client = makeWorkspaceClient(runtime);
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
    await assert.rejects(client.command('saveFile', save), isUncertain);
    await runtime.dispose();
    const restarted = f.start();
    try {
      const restored = await restarted.client.command('loadRecovery', { clientId: 'alice' });
      assert.equal(draftsOf(restored.state)[0]?.text, 'admitted unsaved text');
      assert.deepEqual(draftsOf(restored.state)[0]?.disk, disk);
      assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), 'original');
      // A repeat asks the host, which finds the file as it was: the save settles as a conflict
      // with the restored text kept, in this session rather than after another load.
      assert.equal((await restarted.client.command('saveFile', save)).kind, 'conflict');
      const settled = await restarted.client.command('loadRecovery', { clientId: 'alice' });
      assert.deepEqual(settled.state, restored.state);
      assert.deepEqual(settled.errors, []);
    } finally {
      await restarted.runtime.dispose();
    }
  } finally {
    await runtime.dispose();
    await f.close();
  }
});
