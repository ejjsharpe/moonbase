import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { TestClock } from 'effect/testing';
import { ApplicationError, emptyRecovery } from '@moonbase/application/client';
import { makeEditorClient } from '@moonbase/application/runtime-client';
import { runApplicationEffect } from '@moonbase/application/effect-client';
import { WorkspaceLive, WorkspaceNative } from '@moonbase/workspace';
import { fixture, isError, quote, waitFor } from './recovery-fixture.ts';

function native<R>(runtime: ManagedRuntime.ManagedRuntime<WorkspaceNative | R, ApplicationError>) {
  return {
    capture: (input: Parameters<Effect.Success<typeof WorkspaceNative>['capture']>[0]) =>
      runApplicationEffect(
        runtime,
        Effect.flatMap(WorkspaceNative, (service) => service.capture(input)),
      ),
    release: (input: Parameters<Effect.Success<typeof WorkspaceNative>['release']>[0]) =>
      runApplicationEffect(
        runtime,
        Effect.flatMap(WorkspaceNative, (service) => service.release(input)),
      ),
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
    await api.release({ checkout, clientId: 'alice', references });
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
            "SELECT count(*) AS n FROM records WHERE bucket='saves' AND json_extract(body,'$.input.requestId')='cancelled'",
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
      stored.published = false;
      stored.input.futureRequest = 'private evidence';
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
      Effect.flatMap(WorkspaceNative, (service) =>
        service.capture({ checkout, clientId: 'alice', paths: [join(f.base, 'external')] }),
      ),
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

test('admitted cancellation retains its overlap lease and root resources until the helper actually closes', async () => {
  const f = fixture(),
    ready = join(f.base, 'admitted'),
    release = join(f.base, 'release-descendant');
  const helper = f.wrapper(
    `if [ "$1" = copy ]; then\n (while [ ! -e ${quote(release)} ]; do /bin/sleep 0.01; done) &\n /usr/bin/touch ${quote(ready)}\n while :; do /bin/sleep 0.01; done\nfi`,
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
    successor = client.command('saveFile', {
      target,
      clientId: 'alice',
      requestId: 'overlap',
      text: 'must not race',
      expectedVersion: disk.version,
    });
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
      'root shutdown must join actual helper close before closing Store/FDs',
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
        'uncertain',
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
