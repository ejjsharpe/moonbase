import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { TestClock } from 'effect/testing';
import { makeEditorClient } from '@moonbase/application/runtime-client';
import { emptyRecovery } from '@moonbase/contracts/workspace';
import { WorkspaceLive, WorkspaceNative } from '../src/index.ts';
import { quote, fixture, isError, waitFor } from './recovery-fixture.ts';
test('aliases cannot authorize two same-baseline saves of one macOS object', async () => {
  const f = fixture(),
    { runtime, client } = f.start();
  try {
    assert(
      existsSync(join(f.root, 'FILE.TXT')),
      'This regression requires the case-insensitive macOS fixture volume.',
    );
    const checkout = await client.command('openCheckout', { root: f.root }),
      disk = await client.command('readFile', { checkout, path: 'file.txt' });
    const results = await Promise.allSettled(
      ['file.txt', 'FILE.TXT'].map((path, i) =>
        client.command('saveFile', {
          target: { checkout, path },
          clientId: 'alice',
          requestId: 'alias-' + i,
          text: 'save-' + i,
          expectedVersion: disk.version,
        }),
      ),
    );
    assert.equal(
      results.filter((r) => r.status === 'fulfilled' && r.value.kind === 'saved').length,
      1,
    );
    assert.equal(results[1].status, 'rejected');
    await assert.rejects(
      client.command('readFile', { checkout, path: 'FILE.TXT' }),
      isError('InvalidInput'),
    );
    const sources = await client.command('inspectEntries', { checkout, paths: ['file.txt'] });
    assert.equal(
      (
        await client.command('mutate', {
          clientId: 'alice',
          id: 'case-only',
          checkout,
          kind: 'move',
          sources,
          destination: 'FILE.TXT',
        })
      ).outcome,
      'completed',
    );
    assert.equal((await client.command('readFile', { checkout, path: 'FILE.TXT' })).text, 'save-0');
  } finally {
    await runtime.dispose();
    f.cleanup();
  }
});

for (const kind of ['save', 'move'] as const)
  test(`concurrent changed-payload ${kind} IDs reserve one immutable target before mutation`, async () => {
    const f = fixture(),
      count = join(f.base, 'effects');
    const command = kind === 'save' ? 'replace' : 'move';
    const helper = f.wrapper(
        `if [ "$1" = ${quote(command)} ]; then printf 'effect\\n' >> ${quote(count)}; fi`,
      ),
      { runtime, client } = f.start(helper);
    try {
      writeFileSync(join(f.root, 'other.txt'), 'original');
      const checkout = await client.command('openCheckout', { root: f.root });
      const targets = ['file.txt', 'other.txt'];
      const disk = await client.command('readFile', { checkout, path: targets[0] });
      const sources = await client.command('inspectEntries', { checkout, paths: targets });
      const results = await Promise.allSettled(
        targets.map((path, i) =>
          kind === 'save'
            ? client.command('saveFile', {
                clientId: 'alice',
                requestId: 'shared-id',
                target: { checkout, path },
                text: 'saved-' + i,
                expectedVersion: disk.version,
              })
            : client.command('mutate', {
                clientId: 'alice',
                id: 'shared-id',
                checkout,
                kind: 'move',
                sources: [sources[i]],
                destination: 'moved-' + i,
              }),
        ),
      );
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(
        results.filter((r) => r.status === 'rejected' && isError('Conflict')(r.reason)).length,
        1,
      );
      assert.equal(readFileSync(count, 'utf8'), 'effect\n');
    } finally {
      await runtime.dispose();
      f.cleanup();
    }
  });

test('concurrent different operations can consume a native token only once', async () => {
  const f = fixture(),
    count = join(f.base, 'effects');
  const helper = f.wrapper(`if [ "$1" = import ]; then printf 'effect\\n' >> ${quote(count)}; fi`),
    { runtime, client } = f.start(helper);
  try {
    const external = join(f.base, 'external');
    writeFileSync(external, 'native bytes');
    const checkout = await client.command('openCheckout', { root: f.root });
    const nativeReferences = await runtime.runPromise(
      Effect.flatMap(WorkspaceNative, (native) =>
        native.capture({ checkout, clientId: 'alice', paths: [external] }),
      ),
    );
    const inputs = ['one', 'two'].map((id) => ({
      clientId: 'alice',
      id,
      checkout,
      kind: 'import' as const,
      sources: [],
      nativeReferences,
      destination: id,
    }));
    const outcomes = await Promise.allSettled(
      inputs.map((input) => client.command('mutate', input)),
    );
    assert.equal(
      outcomes.filter((r) => r.status === 'fulfilled' && r.value.outcome === 'completed').length,
      1,
    );
    assert.equal(
      outcomes.filter((r) => r.status === 'rejected' && isError('Unauthorized')(r.reason)).length,
      1,
    );
    assert.equal(readFileSync(count, 'utf8'), 'effect\n');
    const winner = outcomes.findIndex((r) => r.status === 'fulfilled');
    await client.command('mutate', inputs[winner]);
    assert.equal(readFileSync(count, 'utf8'), 'effect\n');
  } finally {
    await runtime.dispose();
    f.cleanup();
  }
});

test('expiry cannot close native descriptors across a multi-item operation longer than five minutes', async () => {
  const f = fixture();
  const helper = f.wrapper(
    `if [ "$1" = import ]; then /usr/bin/touch ${quote(f.base)}/ready-"$2"; while [ ! -e ${quote(f.base)}/resume-"$2" ]; do /bin/sleep 0.01; done; fi`,
  );
  const runtime = ManagedRuntime.make(
    WorkspaceLive({
      dataDirectory: join(f.base, 'state'),
      hostId: 'review-host',
      filesystemHelper: helper,
    }).pipe(Layer.provideMerge(TestClock.layer())),
  );
  const client = makeEditorClient(runtime);
  const names = Array.from({ length: 16 }, (_, i) => 'external-' + i);
  try {
    const external = names.map((name) => join(f.base, name));
    external.forEach((p) => writeFileSync(p, 'native bytes'));
    mkdirSync(join(f.root, 'imports'));
    const checkout = await client.command('openCheckout', { root: f.root });
    const nativeReferences = await runtime.runPromise(
      Effect.flatMap(WorkspaceNative, (native) =>
        native.capture({ checkout, clientId: 'alice', paths: external }),
      ),
    );
    const pending = client.command('mutate', {
      clientId: 'alice',
      id: 'expiry',
      checkout,
      kind: 'import',
      sources: [],
      nativeReferences,
      destination: 'imports',
    });
    void pending.catch(() => {});
    for (const name of names) {
      await waitFor(join(f.base, 'ready-' + name));
      // Each helper remains under its 30s budget; the claimed selection outlives 5m overall.
      await runtime.runPromise(TestClock.adjust('20 seconds'));
      writeFileSync(join(f.base, 'resume-' + name), 'continue');
    }
    assert.equal((await pending).outcome, 'completed');
    for (const name of names)
      assert.equal(readFileSync(join(f.root, 'imports', name), 'utf8'), 'native bytes');
    await runtime.runPromise(
      Effect.flatMap(WorkspaceNative, (native) =>
        native.release({ checkout, clientId: 'alice', references: nativeReferences }),
      ),
    );
  } finally {
    for (const name of names) writeFileSync(join(f.base, 'resume-' + name), 'continue');
    await runtime.dispose();
    f.cleanup();
  }
});

for (const kind of ['move', 'copy'] as const)
  test(`local ${kind} cannot replace an ancestor containing its selected dirty source`, async () => {
    const f = fixture(),
      count = join(f.base, 'trash-count');
    const helper = f.wrapper(
        `if [ "$1" = trash ]; then printf 'unsafe trash\\n' >> ${quote(count)}; exit 1; fi`,
      ),
      { runtime, client } = f.start(helper);
    try {
      mkdirSync(join(f.root, 'folder'));
      writeFileSync(join(f.root, 'folder/child.txt'), 'must survive');
      const checkout = await client.command('openCheckout', { root: f.root }),
        target = { checkout, path: 'folder/child.txt' },
        disk = await client.command('readFile', target);
      const snapshot = {
        ...emptyRecovery('alice'),
        checkouts: [checkout],
        openCheckoutIds: [checkout.checkoutId],
        drafts: [{ target, disk, text: 'dirty child' }],
      };
      await client.command('persistRecovery', {
        requestId: randomUUID(),
        clientId: 'alice',
        expectedRevision: 0,
        state: snapshot,
      });
      const sources = await client.command('inspectEntries', {
          checkout,
          paths: ['folder/child.txt'],
        }),
        replacements = await client.command('inspectEntries', { checkout, paths: ['folder'] });
      await assert.rejects(
        client.command('mutate', {
          clientId: 'alice',
          id: 'local-ancestor',
          checkout,
          kind,
          sources,
          replacements,
          destination: 'folder',
        }),
        isError('InvalidInput'),
      );
      assert(!existsSync(count), 'Ancestor replacement must reject before native Trash.');
      assert.equal(
        await client.command('operationStatus', { clientId: 'alice', id: 'local-ancestor' }),
        null,
      );
      assert.equal(readFileSync(join(f.root, 'folder/child.txt'), 'utf8'), 'must survive');
      assert.deepEqual(
        (await client.command('loadRecovery', { clientId: 'alice' })).state,
        snapshot,
      );
    } finally {
      await runtime.dispose();
      f.cleanup();
    }
  });

for (const selection of ['self', 'descendant', 'ancestor'] as const)
  test(`native ${selection} import rejects before replacement Trash`, async () => {
    const f = fixture(),
      count = join(f.base, 'trash-count');
    const helper = f.wrapper(
        `if [ "$1" = trash ]; then printf 'trash\\n' >> ${quote(count)}; exit 1; fi`,
      ),
      { runtime, client } = f.start(helper);
    try {
      if (selection !== 'self') {
        mkdirSync(join(f.root, 'source'));
        writeFileSync(join(f.root, 'source/child'), 'keep child');
      }
      const checkout = await client.command('openCheckout', { root: f.root });
      let source = 'file.txt',
        destination = source;
      if (selection === 'descendant') {
        source = 'source';
        destination = 'source/child';
      } else if (selection === 'ancestor') {
        source = 'source/child';
        destination = 'source';
      }
      const nativeReferences = await runtime.runPromise(
        Effect.flatMap(WorkspaceNative, (native) =>
          native.capture({ checkout, clientId: 'alice', paths: [join(f.root, source)] }),
        ),
      );
      const replacements = await client.command('inspectEntries', {
        checkout,
        paths: [destination],
      });
      await assert.rejects(
        client.command('mutate', {
          id: 'self-import',
          clientId: 'alice',
          checkout,
          kind: 'import',
          sources: [],
          destination,
          replacements,
          nativeReferences,
        }),
      );
      assert(!existsSync(count), 'Unsafe import must not invoke native Trash.');
      assert.equal(
        readFileSync(join(f.root, selection === 'self' ? destination : 'source/child'), 'utf8'),
        selection === 'self' ? 'original' : 'keep child',
      );
    } finally {
      await runtime.dispose();
      f.cleanup();
    }
  });
