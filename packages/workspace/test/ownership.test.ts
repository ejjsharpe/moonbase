import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { TestClock } from 'effect/testing';
import {
  ApplicationError,
  emptyRecovery,
  type EditorRecovery,
} from '@moonbase/contracts/workspace';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import { runApplicationEffect } from '@moonbase/application/runtime/effect-client';
import { reconcile } from '../src/client/reconcile.ts';
import { WorkspaceLive } from './workspace-live-fixture.ts';
import { fixture, isError, quote, waitFor } from './recovery-fixture.ts';
import { captureNative, releaseNative } from './workspace-fixture.ts';
import { WorkspaceHostService } from '@moonbase/contracts/services';

function native<R>(
  runtime: ManagedRuntime.ManagedRuntime<WorkspaceHostService | R, ApplicationError>,
) {
  return {
    capture: (input: Parameters<typeof captureNative>[0]) =>
      runApplicationEffect(runtime, captureNative(input)),
    release: (input: Parameters<typeof releaseNative>[0]) =>
      runApplicationEffect(runtime, releaseNative(input)),
  };
}

test('native release validates the whole known batch, is idempotent, and releases only its exact owner', async () => {
  const f = fixture(),
    { runtime, client } = f.start();
  try {
    const checkout = await client.command('openCheckout', { root: f.root });
    const paths = ['one', 'two'].map((name) => join(f.base, name));
    paths.forEach((path) => writeFileSync(path, 'native bytes'));
    const api = native(runtime);
    const [alice, bob] = await Promise.all([
      api.capture({ checkout, clientId: 'alice', paths: [paths[0]] }),
      api.capture({ checkout, clientId: 'bob', paths: [paths[1]] }),
    ]);
    await assert.rejects(
      api.release({ checkout, clientId: 'alice', references: [...alice, ...bob] }),
      isError('Unauthorized'),
    );
    const importAlice = {
      checkout,
      clientId: 'alice',
      id: 'alice-import',
      kind: 'import' as const,
      sources: [],
      nativeReferences: alice,
      destination: 'imported',
    };
    assert.equal(
      (await client.command('mutate', importAlice)).outcome,
      'completed',
      'failed batch release must not release its valid prefix',
    );
    await api.release({ checkout, clientId: 'alice', references: alice });
    await api.release({ checkout, clientId: 'alice', references: alice });
    await api.release({ checkout, clientId: 'bob', references: bob });
    await api.release({ checkout, clientId: 'bob', references: bob });
    await assert.rejects(
      client.command('mutate', {
        ...importAlice,
        id: 'bob-import',
        clientId: 'bob',
        nativeReferences: bob,
        destination: 'never',
      }),
      isError('Unauthorized'),
    );
    assert(!existsSync(join(f.root, 'never')));
  } finally {
    await runtime.dispose();
    f.cleanup();
  }
});

test('unclaimed references expire in their owning scope and cannot be imported after five minutes', async () => {
  const f = fixture();
  const runtime = ManagedRuntime.make(
    WorkspaceLive({ dataDirectory: join(f.base, 'state'), hostId: 'review-host' }).pipe(
      Layer.provideMerge(TestClock.layer()),
    ),
  );
  const client = makeEditorClient(runtime);
  try {
    const checkout = await client.command('openCheckout', { root: f.root });
    writeFileSync(join(f.base, 'external'), 'native bytes');
    const api = native(runtime),
      references = await api.capture({
        checkout,
        clientId: 'alice',
        paths: [join(f.base, 'external')],
      });
    await runtime.runPromise(TestClock.adjust('5 minutes'));
    await assert.rejects(
      client.command('mutate', {
        checkout,
        clientId: 'alice',
        id: 'expired',
        kind: 'import',
        sources: [],
        nativeReferences: references,
        destination: 'never',
      }),
      isError('Unauthorized'),
    );
    assert(!existsSync(join(f.root, 'never')));
    await api.release({ checkout, clientId: 'alice', references });
  } finally {
    await runtime.dispose();
    f.cleanup();
  }
});

test('failed durable import reservation leaves native references unclaimed for the original retry', async () => {
  const f = fixture(),
    count = join(f.base, 'imports');
  const helper = f.wrapper(`if [ "$1" = import ]; then printf 'import\\n' >> ${quote(count)}; fi`);
  const { runtime, client } = f.start(helper);
  try {
    const checkout = await client.command('openCheckout', { root: f.root });
    const source = join(f.base, 'external');
    writeFileSync(source, 'native bytes');
    const references = await native(runtime).capture({
      checkout,
      clientId: 'alice',
      paths: [source],
    });
    const input = {
      checkout,
      clientId: 'alice',
      id: 'reserved-import',
      kind: 'import' as const,
      sources: [],
      nativeReferences: references,
      destination: 'imported',
    };
    const lock = new DatabaseSync(join(f.base, 'state', 'moonbase-workspace-v1.sqlite'));
    try {
      lock.exec('BEGIN IMMEDIATE');
      await assert.rejects(client.command('mutate', input), isError('Persistence'));
      assert.equal(
        await client.command('operationStatus', { clientId: 'alice', id: input.id }),
        null,
      );
      assert(!existsSync(join(f.root, 'imported')));
      assert(!existsSync(count), 'reservation failure must not run the import helper');
    } finally {
      lock.exec('ROLLBACK');
      lock.close();
    }
    assert.equal((await client.command('mutate', input)).outcome, 'completed');
    assert.equal(readFileSync(join(f.root, 'imported'), 'utf8'), 'native bytes');
    assert.equal(readFileSync(count, 'utf8'), 'import\n');
  } finally {
    await runtime.dispose();
    f.cleanup();
  }
});

test('cancelled queued Save releases its lease without admission and successors stay ordered', async () => {
  const f = fixture(),
    ready = join(f.base, 'ready'),
    resume = join(f.base, 'resume'),
    effects = join(f.base, 'effects');
  const helper = f.wrapper(
    `if [ "$1" = stage ]; then printf '%s\\n' "$2" >> ${quote(effects)}; /usr/bin/touch ${quote(ready)}; while [ ! -e ${quote(resume)} ]; do /bin/sleep 0.01; done; fi`,
  );
  const { runtime, client } = f.start(helper),
    abort = new AbortController();
  let first: Promise<unknown> | undefined;
  try {
    writeFileSync(join(f.root, 'other.txt'), 'unrelated');
    const checkout = await client.command('openCheckout', { root: f.root }),
      target = { checkout, path: 'file.txt' },
      disk = await client.command('readFile', target);
    const input = { clientId: 'alice', target, text: 'first', expectedVersion: disk.version };
    first = client.command('saveFile', { ...input, requestId: 'first' });
    void first.catch(() => {});
    await waitFor(ready);
    const queued = client.command(
      'saveFile',
      { ...input, requestId: 'cancelled', text: 'must not publish' },
      { signal: abort.signal },
    );
    const rejected = assert.rejects(queued, isError('Cancelled'));
    abort.abort();
    await rejected;
    const successor = client.command('saveFile', {
      ...input,
      requestId: 'successor',
      text: 'stale successor',
    });
    assert.equal(
      (await client.command('readFile', { checkout, path: 'other.txt' })).text,
      'unrelated',
    );
    writeFileSync(resume, 'continue');
    assert.equal(((await first) as { kind: string }).kind, 'saved');
    assert.equal((await successor).kind, 'conflict');
    assert.equal(readFileSync(effects, 'utf8'), 'file.txt\n');
    const db = new DatabaseSync(join(f.base, 'state/moonbase-workspace-v1.sqlite'));
    try {
      assert.equal(
        db
          .prepare(
            "SELECT count(*) AS n FROM records WHERE bucket='saves' AND json_extract(body,'$.request.requestId')='cancelled'",
          )
          .get()!.n,
        0,
      );
    } finally {
      db.close();
    }
    assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), 'first');
  } finally {
    abort.abort();
    writeFileSync(resume, 'continue');
    await first?.catch(() => {});
    await runtime.dispose();
    f.cleanup();
  }
});

test('strict saved recovery blocks load and later direct publication without changing original bytes', async () => {
  const f = fixture(),
    { runtime, client } = f.start();
  try {
    const checkout = await client.command('openCheckout', { root: f.root }),
      target = { checkout, path: 'file.txt' },
      disk = await client.command('readFile', target);
    const state = {
      ...emptyRecovery('alice'),
      checkouts: [checkout],
      openCheckoutIds: [checkout.checkoutId],
      drafts: [{ target, text: 'saved draft', disk }],
    };
    await client.command('persistRecovery', {
      clientId: 'alice',
      requestId: 'initial',
      expectedRevision: 0,
      state,
    });
    const db = new DatabaseSync(join(f.base, 'state/moonbase-workspace-v1.sqlite'));
    try {
      const original = JSON.stringify({
        ...state,
        drafts: [{ ...state.drafts[0], futureNote: 'retained evidence' }],
      });
      db.prepare('UPDATE recovery SET body=? WHERE client=?').run(original, 'alice');
      const before = db.prepare('SELECT revision,body FROM recovery WHERE client=?').get('alice');
      const safe = (error: unknown) => {
        assert(isError('Persistence')(error));
        assert(!String(error).includes('retained evidence'));
        return true;
      };
      await assert.rejects(client.command('loadRecovery', { clientId: 'alice' }), safe);
      await assert.rejects(
        client.command('persistRecovery', {
          clientId: 'alice',
          requestId: 'overwrite',
          expectedRevision: 1,
          state,
        }),
        safe,
      );
      assert.deepEqual(
        db.prepare('SELECT revision,body FROM recovery WHERE client=?').get('alice'),
        before,
      );
      assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), 'original');
    } finally {
      db.close();
    }
  } finally {
    await runtime.dispose();
    f.cleanup();
  }
});

test('strict private saved request rejection leaves pending journal data untouched and never replays native work', async () => {
  const f = fixture(),
    { runtime, client } = f.start();
  try {
    const checkout = await client.command('openCheckout', { root: f.root }),
      target = { checkout, path: 'file.txt' },
      disk = await client.command('readFile', target);
    const input = {
      target,
      clientId: 'alice',
      requestId: 'saved',
      expectedVersion: disk.version,
      text: 'confirmed',
    };
    await client.command('saveFile', input);
    const db = new DatabaseSync(join(f.base, 'state/moonbase-workspace-v1.sqlite'));
    try {
      const row = db.prepare("SELECT key,body FROM records WHERE bucket='saves'").get()!;
      const stored = JSON.parse(row.body as string);
      stored.state = 'sent';
      stored.request.futureRequest = 'private evidence';
      const original = JSON.stringify(stored);
      db.prepare("UPDATE records SET body=? WHERE bucket='saves' AND key=?").run(
        original,
        row.key!,
      );
      await assert.rejects(
        client.command('loadRecovery', { clientId: 'alice' }),
        isError('Persistence'),
      );
      await assert.rejects(client.command('saveFile', input), isError('Persistence'));
      assert.equal(
        db.prepare("SELECT body FROM records WHERE bucket='saves' AND key=?").get(row.key!)!.body,
        original,
      );
      assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), 'confirmed');
    } finally {
      db.close();
    }
  } finally {
    await runtime.dispose();
    f.cleanup();
  }
});

test('capture cancellation settles its helper and releases descriptors before returning cancellation', async () => {
  const f = fixture(),
    ready = join(f.base, 'capture-ready');
  const helper = f.wrapper(
    `if [ "$1" = import-check ]; then /usr/bin/touch ${quote(ready)}; while :; do /bin/sleep 0.01; done; fi`,
  );
  const { runtime, client } = f.start(helper),
    abort = new AbortController();
  try {
    const checkout = await client.command('openCheckout', { root: f.root });
    await client.command('readFile', { checkout, path: 'file.txt' });
    writeFileSync(join(f.base, 'external'), 'native bytes');
    const before = readdirSync('/dev/fd').length;
    const capturing = runApplicationEffect(
      runtime,
      captureNative({ checkout, clientId: 'alice', paths: [join(f.base, 'external')] }),
      { signal: abort.signal },
    );
    const rejected = assert.rejects(capturing, isError('Cancelled'));
    await waitFor(ready);
    abort.abort();
    await rejected;
    assert.equal(readdirSync('/dev/fd').length, before);
    assert.equal(
      (await client.command('readFile', { checkout, path: 'file.txt' })).text,
      'original',
    );
  } finally {
    abort.abort();
    await runtime.dispose();
    f.cleanup();
  }
});

test('failing native releases remain observable and do not skip sibling references or directory cleanup', async () => {
  const f = fixture(),
    { runtime, client } = f.start();
  let restore = () => {};
  try {
    const checkout = await client.command('openCheckout', { root: f.root });
    await client.command('readFile', { checkout, path: 'file.txt' });
    const paths = ['one', 'two'].map((name) => join(f.base, name));
    paths.forEach((p) => writeFileSync(p, 'native bytes'));
    await native(runtime).capture({ checkout, clientId: 'alice', paths });
    const sourceIds = new Set(paths.map((p) => statSync(p).ino));
    const directoryId = statSync(f.root).ino;
    const released = new Set<number>();
    let directoryClosed = false;
    const original = fs.closeSync;
    mock.method(fs, 'closeSync', (fd: number) => {
      const inode = fs.fstatSync(fd).ino;
      original(fd);
      if (inode === directoryId) directoryClosed = true;
      if (sourceIds.has(inode)) {
        released.add(inode);
        throw new ApplicationError({
          code: 'Unavailable',
          message: 'Controlled native release failure',
        });
      }
    });
    syncBuiltinESMExports();
    restore = () => {
      mock.restoreAll();
      syncBuiltinESMExports();
    };
    await assert.rejects(runtime.dispose(), /Controlled native release failure/);
    assert.equal(released.size, 2);
    assert.equal(directoryClosed, true);
  } finally {
    restore();
    await runtime.dispose().catch(() => {});
    f.cleanup();
  }
});

test('private configuration rejects unsafe shapes before creating a state directory and returns safe errors', async () => {
  const f = fixture(),
    dataDirectory = join(f.base, 'never-created');
  const invalid: unknown[] = [
    null,
    {},
    { dataDirectory, hostId: 'bad identity' },
    { dataDirectory, hostId: 'local', gitExecutable: 'relative-private-path' },
    { dataDirectory, hostId: 'local', filesystemHelper: '/private-secret\0binary' },
  ];
  try {
    for (const value of invalid) {
      const runtime = ManagedRuntime.make(WorkspaceLive(value as never));
      try {
        await assert.rejects(
          makeEditorClient(runtime).command('loadRecovery', { clientId: 'alice' }),
          (error: unknown) => {
            assert(isError('InvalidInput')(error));
            assert(!String(error).includes('private-secret'));
            assert(!String(error).includes('relative-private-path'));
            return true;
          },
        );
      } finally {
        await runtime.dispose().catch(() => {});
      }
      assert.equal(existsSync(dataDirectory), false);
    }
  } finally {
    f.cleanup();
  }
});

test('admitted cancellation retains its overlap lease and root resources until the helper actually exits', async () => {
  const f = fixture(),
    ready = join(f.base, 'admitted'),
    release = join(f.base, 'release-descendant');
  // The helper ignores the stop request, so it keeps running until released.
  const helper = f.wrapper(
    `if [ "$1" = copy ]; then\n trap '' TERM\n /usr/bin/touch ${quote(ready)}\n while [ ! -e ${quote(release)} ]; do /bin/sleep 0.01; done\n exit 1\nfi`,
  );
  const { runtime, client } = f.start(helper),
    abort = new AbortController();
  let successor: Promise<unknown> | undefined, closing: Promise<void> | undefined;
  try {
    writeFileSync(join(f.root, 'unrelated'), 'usable');
    const checkout = await client.command('openCheckout', { root: f.root }),
      target = { checkout, path: 'file.txt' },
      disk = await client.command('readFile', target);
    const sources = await client.command('inspectEntries', { checkout, paths: ['file.txt'] });
    const mutation = client.command(
      'mutate',
      { checkout, clientId: 'alice', id: 'held-copy', kind: 'copy', sources, destination: 'copy' },
      { signal: abort.signal },
    );
    const rejected = assert.rejects(mutation, isError('Cancelled'));
    await waitFor(ready);
    abort.abort();
    await rejected;
    let successorSettled = false;
    // Sent to the host itself: the client refuses it at once, as the copy is still unresolved,
    // so only the host's lease can hold it.
    successor = runtime.runPromise(
      Effect.flatMap(WorkspaceHostService, (host) =>
        host.saveFile({
          installationId: 'test-installation',
          target,
          clientId: 'alice',
          requestId: 'overlap',
          text: 'must not race',
          expectedVersion: disk.version,
        }),
      ),
    );
    void successor.then(
      () => {
        successorSettled = true;
      },
      () => {
        successorSettled = true;
      },
    );
    assert.equal(
      (await client.command('readFile', { checkout, path: 'unrelated' })).text,
      'usable',
    );
    assert.equal(
      successorSettled,
      false,
      'the interrupted waiter must not release its admitted overlap lease',
    );
    let disposed = false;
    closing = runtime.dispose().then(() => {
      disposed = true;
    });
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(
      disposed,
      false,
      'root shutdown must join actual helper exit before closing Store/FDs',
    );
    writeFileSync(release, 'continue');
    await closing;
    await successor.catch(() => {});
    assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), 'original');
    const reopened = f.start();
    try {
      assert.equal(
        (await reopened.client.command('operationStatus', { clientId: 'alice', id: 'held-copy' }))
          ?.outcome,
        'failed',
      );
    } finally {
      await reopened.runtime.dispose();
    }
  } finally {
    abort.abort();
    writeFileSync(release, 'continue');
    await successor?.catch(() => {});
    await closing?.catch(() => {});
    await runtime.dispose();
    f.cleanup();
  }
});

test('root disposal retains claimed native descriptors and journal ownership until actual helper exit', async () => {
  const f = fixture(),
    ready = join(f.base, 'import-admitted'),
    release = join(f.base, 'release-import');
  // The helper ignores the stop request, as above.
  const helper = f.wrapper(
    `if [ "$1" = import ]; then\n trap '' TERM\n /usr/bin/touch ${quote(ready)}\n while [ ! -e ${quote(release)} ]; do /bin/sleep 0.01; done\n exit 1\nfi`,
  );
  const { runtime, client } = f.start(helper);
  let mutation: Promise<unknown> | undefined, closing: Promise<void> | undefined;
  try {
    const checkout = await client.command('openCheckout', { root: f.root });
    const source = join(f.base, 'external');
    writeFileSync(source, 'native bytes');
    const references = await native(runtime).capture({
      checkout,
      clientId: 'alice',
      paths: [source],
    });
    mutation = client.command('mutate', {
      checkout,
      clientId: 'alice',
      id: 'held-import',
      kind: 'import',
      sources: [],
      nativeReferences: references,
      destination: 'imported',
    });
    void mutation.catch(() => {});
    await waitFor(ready);
    const sourceId = statSync(source).ino;
    const descriptors = readdirSync('/dev/fd')
      .map(Number)
      .filter((fd) => {
        try {
          return fs.fstatSync(fd).ino === sourceId;
        } catch {
          return false;
        }
      });
    assert.equal(descriptors.length, 1);
    await native(runtime).release({ checkout, clientId: 'alice', references });
    assert.equal(
      fs.fstatSync(descriptors[0]).ino,
      sourceId,
      'document release cannot close a claimed descriptor',
    );
    assert.equal(
      (await client.command('readFile', { checkout, path: 'file.txt' })).text,
      'original',
    );
    let disposed = false;
    closing = runtime.dispose().then(() => {
      disposed = true;
    });
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(disposed, false);
    assert.equal(
      fs.fstatSync(descriptors[0]).ino,
      sourceId,
      'root must join helper exit before descriptor release',
    );
    writeFileSync(release, 'continue');
    await closing;
    await mutation.catch(() => {});
    assert.throws(() => fs.fstatSync(descriptors[0]), { code: 'EBADF' });
    const reopened = f.start();
    try {
      assert.equal(
        (await reopened.client.command('operationStatus', { clientId: 'alice', id: 'held-import' }))
          ?.outcome,
        'failed',
      );
    } finally {
      await reopened.runtime.dispose();
    }
  } finally {
    writeFileSync(release, 'continue');
    await mutation?.catch(() => {});
    await closing?.catch(() => {});
    await runtime.dispose();
    f.cleanup();
  }
});

test('a process the helper left running outside its group holding its output delays neither a reply nor shutdown', async () => {
  const f = fixture(),
    release = join(f.base, 'release-escaped');
  // Job control gives the descendant its own process group, so stopping the helper's group never
  // reaches it, and it holds the helper's stdout and stderr open.
  const helper = f.wrapper(
    `if [ "$1" = read ]; then\n set -m\n (while [ ! -e ${quote(release)} ]; do /bin/sleep 0.01; done) &\nfi`,
  );
  const { runtime, client } = f.start(helper);
  try {
    const checkout = await client.command('openCheckout', { root: f.root });
    assert.equal(
      (await client.command('readFile', { checkout, path: 'file.txt' })).text,
      'original',
    );
    await runtime.dispose();
  } finally {
    writeFileSync(release, 'continue');
    await runtime.dispose();
    f.cleanup();
  }
});

test('public workspace IO normalizes unknown helper failures without rebranding raw private diagnostics', async () => {
  const f = fixture();
  const enabled = join(f.base, 'private-failure-enabled');
  const helper = f.wrapper(
    `if [ -e ${quote(enabled)} ]; then case "$1" in read|git|lookup) printf '%s\n' 'credential-like-private-value /private/host/configuration' >&2; exit 1;; esac; fi`,
  );
  const { runtime, client } = f.start(helper);
  try {
    const checkout = await client.command('openCheckout', { root: f.root });
    writeFileSync(enabled, 'enabled');
    await assert.rejects(
      client.command('readFile', { checkout, path: 'file.txt' }),
      (error: unknown) => {
        assert(isError('Unavailable')(error));
        assert(!String(error).includes('credential-like-private-value'));
        assert(!String(error).includes('/private/host/configuration'));
        return true;
      },
    );
    for (const diagnostic of [
      await client.command('gitStatus', { checkout }),
      await client.command('lookupFiles', { checkout, query: 'file' }),
    ]) {
      assert(diagnostic.error);
      assert(!diagnostic.error.includes('credential-like-private-value'));
      assert(!diagnostic.error.includes('/private/host/configuration'));
    }
    await assert.rejects(
      client.command('readFile', { checkout, path: '../escape' }),
      isError('InvalidInput'),
    );
  } finally {
    await runtime.dispose();
    f.cleanup();
  }
});

test('saved recovery naming a foreign checkout, an escaping path or a wrong baseline blocks later publication without replacing the row', async () => {
  const f = fixture(),
    { runtime, client } = f.start();
  try {
    const checkout = await client.command('openCheckout', { root: f.root }),
      target = { checkout, path: 'file.txt' },
      disk = await client.command('readFile', target);
    const state = {
      ...emptyRecovery('alice'),
      checkouts: [checkout],
      openCheckoutIds: [checkout.checkoutId],
      drafts: [{ target, text: 'retained draft', disk }],
    };
    const wrongBaseline = {
      ...state,
      drafts: [{ ...state.drafts[0], disk: { ...disk, version: 'f'.repeat(64) } }],
    };
    const escapingPosition: EditorRecovery = {
      ...state,
      views: {
        [checkout.checkoutId]: {
          openFiles: [],
          active: '',
          preview: null,
          fileViews: {},
          tree: { expanded: [], selected: [], focus: '', scroll: 0 },
          positions: { '../escape.txt': { file: { line: 1, column: 1, top: 0, left: 0 } } },
        },
      },
    };
    // A recovery the store could not read back is never written.
    for (const [index, unreadable] of [wrongBaseline, escapingPosition].entries())
      await assert.rejects(
        client.command('persistRecovery', {
          clientId: 'alice',
          requestId: 'unreadable-' + index,
          expectedRevision: 0,
          state: unreadable,
        }),
        isError('InvalidInput'),
      );
    // A host's move to a path outside the checkout moves nothing in the recovery.
    const moved = structuredClone(escapingPosition);
    moved.views[checkout.checkoutId]!.positions = { 'file.txt': {} };
    reconcile(moved, [
      {
        input: { kind: 'move', checkout },
        result: {
          items: [{ source: 'file.txt', destination: '../escape.txt', outcome: 'completed' }],
        },
      } as never,
    ]);
    assert.deepEqual(moved.drafts, state.drafts);
    assert.deepEqual(Object.keys(moved.views[checkout.checkoutId]!.positions), ['file.txt']);
    await client.command('persistRecovery', {
      clientId: 'alice',
      requestId: 'initial-domain',
      expectedRevision: 0,
      state,
    });
    const invalid = [
      {
        ...state,
        drafts: [
          {
            ...state.drafts[0],
            target: { ...target, checkout: { ...checkout, checkoutId: 'foreign-checkout' } },
          },
        ],
      },
      { ...state, drafts: [{ ...state.drafts[0], target: { ...target, path: '../escape' } }] },
      wrongBaseline,
    ];
    const database = new DatabaseSync(join(f.base, 'state/moonbase-workspace-v1.sqlite'));
    try {
      for (const [index, prior] of invalid.entries()) {
        const body = JSON.stringify(prior);
        database.prepare('UPDATE recovery SET body=? WHERE client=?').run(body, 'alice');
        const before = database
          .prepare('SELECT revision,body FROM recovery WHERE client=?')
          .get('alice');
        await assert.rejects(
          client.command('loadRecovery', { clientId: 'alice' }),
          isError('Persistence'),
        );
        await assert.rejects(
          client.command('persistRecovery', {
            clientId: 'alice',
            requestId: 'replace-domain-' + index,
            expectedRevision: 1,
            state,
          }),
          isError('Persistence'),
        );
        assert.deepEqual(
          database.prepare('SELECT revision,body FROM recovery WHERE client=?').get('alice'),
          before,
        );
        assert.equal(
          await client.command('getRecoveryPublication', {
            clientId: 'alice',
            requestId: 'replace-domain-' + index,
          }),
          null,
        );
      }
      assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), 'original');
    } finally {
      database.close();
    }
  } finally {
    await runtime.dispose();
    f.cleanup();
  }
});

test(
  'continuous filesystem writes still deliver a coalesced watch event before the writer becomes quiet',
  { timeout: 5000 },
  async () => {
    const f = fixture(),
      { runtime, client } = f.start();
    let close = async () => {};
    try {
      const checkout = await client.command('openCheckout', { root: f.root });
      let ready!: () => void,
        writing = true,
        deliveredDuringWrites = 0;
      const initial = new Promise<void>((done) => {
        ready = done;
      });
      const failures: unknown[] = [];
      close = client.watch(
        { checkout, paths: [''] },
        (event) => {
          if (event.ready) ready();
          else if (writing) deliveredDuringWrites++;
        },
        (error) => failures.push(error),
      );
      await initial;
      for (let i = 0; i < 50; i++) {
        writeFileSync(join(f.root, 'burst-' + i), 'changed');
        await new Promise<void>((done) => setTimeout(done, 25));
      }
      writing = false;
      assert(
        deliveredDuringWrites > 0,
        '100ms coalescing must not wait indefinitely for a quiet filesystem',
      );
      await close();
      assert.deepEqual(failures, []);
    } finally {
      await close();
      await runtime.dispose();
      f.cleanup();
    }
  },
);

test('mutation cancellation during preflight reserves no ID and consumes no native reference', async () => {
  const f = fixture(),
    { runtime, client } = f.start();
  try {
    const checkout = await client.command('openCheckout', { root: f.root });
    await client.command('readFile', { checkout, path: 'file.txt' });
    writeFileSync(join(f.base, 'unclaimed-external'), 'native bytes');
    const references = await native(runtime).capture({
      checkout,
      clientId: 'alice',
      paths: [join(f.base, 'unclaimed-external')],
    });
    for (const kind of ['create-file', 'import'] as const) {
      const input = {
        checkout,
        clientId: 'alice',
        id: 'preflight-' + kind,
        kind,
        sources: [],
        destination: 'after-' + kind,
        ...(kind === 'import' ? { nativeReferences: references } : { text: 'created' }),
      };
      const abort = new AbortController();
      const pending = client.command('mutate', input, { signal: abort.signal });
      const rejected = assert.rejects(pending, isError('Cancelled'));
      queueMicrotask(() => abort.abort());
      await rejected;
      await client.command('readFile', { checkout, path: 'file.txt' });
      // The host reserved nothing, but a status query fences the ID, so the selection runs again
      // under a new one.
      assert.equal(
        (await client.command('mutate', { ...input, id: input.id + '-again' })).outcome,
        'completed',
        'the native selection must remain usable after preflight cancellation',
      );
      assert.equal(
        readFileSync(join(f.root, input.destination), 'utf8'),
        kind === 'import' ? 'native bytes' : 'created',
      );
    }
  } finally {
    await runtime.dispose();
    f.cleanup();
  }
});

test('watch acquisition leaves unrelated commands responsive and root disposal closes every acquired watcher', async () => {
  const f = fixture(),
    { runtime, client } = f.start();
  const actualWatch = fs.watch;
  let acquired!: () => void, failed!: (error: unknown) => void;
  const acquiring = new Promise<void>((resolve, reject) => {
    acquired = resolve;
    failed = reject;
  });
  let opened = 0,
    closed = 0,
    delivered = 0;
  let stop = async () => {};
  try {
    const checkout = await client.command('openCheckout', { root: f.root });
    const paths = Array.from({ length: 32 }, (_, i) => 'directory-' + i);
    for (const path of paths) mkdirSync(join(f.root, path));
    mock.method(fs, 'watch', (...args: Parameters<typeof fs.watch>) => {
      const watcher: fs.FSWatcher = Reflect.apply(actualWatch, fs, args);
      opened++;
      watcher.once('close', () => closed++);
      acquired();
      return watcher;
    });
    syncBuiltinESMExports();
    stop = client.watch({ checkout, paths }, () => delivered++, failed);
    await acquiring;
    const entries = await client.command('inspectEntries', { checkout, paths: ['file.txt'] });
    assert.equal(entries[0].directory, false);
    assert(opened < paths.length, 'unrelated command completes during acquisition');
    assert.equal(delivered, 0, 'subscription is still acquiring');
    await Promise.all([stop(), runtime.dispose()]);
    assert.equal(closed, opened);
    assert.equal(delivered, 0);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    await stop();
    await runtime.dispose();
    f.cleanup();
  }
});

test('failed observation release stays root-owned, is retried, and remains visible while siblings close', async () => {
  const f = fixture(),
    { runtime, client } = f.start();
  const actualWatch = fs.watch;
  let restored = false,
    firstFailure = true,
    attempts = 0,
    closed = 0;
  const handles: fs.FSWatcher[] = [];
  const closeOriginal: (() => void)[] = [];
  let off = async () => {};
  try {
    const checkout = await client.command('openCheckout', { root: f.root });
    mock.method(fs, 'watch', (...args: Parameters<typeof fs.watch>) => {
      const watcher: fs.FSWatcher = Reflect.apply(actualWatch, fs, args);
      const close = watcher.close.bind(watcher);
      handles.push(watcher);
      closeOriginal.push(close);
      watcher.once('close', () => closed++);
      watcher.close = () => {
        attempts++;
        if (firstFailure) {
          firstFailure = false;
          throw new ApplicationError({
            code: 'Unavailable',
            message: 'Controlled watcher release failure',
          });
        }
        close();
      };
      return watcher;
    });
    syncBuiltinESMExports();
    const start = () =>
      new Promise<() => Promise<void>>((resolve, reject) => {
        const stop = client.watch(
          { checkout, paths: [''] },
          (event) => {
            if (event.ready) resolve(stop);
          },
          reject,
        );
      });
    off = await start();
    await start();
    await assert.rejects(off(), /Controlled watcher release failure/);
    assert.equal(closed, 0);
    await assert.rejects(runtime.dispose(), /Controlled watcher release failure/);
    assert.equal(
      closed,
      handles.length,
      'root retries the failed native close and still closes sibling observations',
    );
    assert(attempts > handles.length);
    mock.restoreAll();
    syncBuiltinESMExports();
    restored = true;
  } finally {
    if (!restored) {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
    for (const close of closeOriginal) close();
    await off().catch(() => {});
    await runtime.dispose().catch(() => {});
    f.cleanup();
  }
});
