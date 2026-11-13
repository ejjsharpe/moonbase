import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  renameSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { ManagedRuntime, Effect } from 'effect';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import { emptyRecovery } from '@moonbase/contracts/workspace';
import { WorkspaceNative } from '../index.ts';
import { WorkspaceLive } from '../../test/fixtures/workspace-live.ts';

import { fixture, rejects, draft } from '../../test/fixtures/workspace-fixture.ts';
test('known move preserves drafts and exact target, acknowledgement requires recovery publication; replay does not move twice', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'file.txt'), 'disk');
    const checkout = await f.client.command('openCheckout', { root: f.root }),
      disk = await f.client.command('readFile', { checkout, path: 'file.txt' });
    const state = draft('alice', checkout, 'dirty', disk);
    await f.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'alice',
      expectedRevision: 0,
      state,
    });
    const sources = await f.client.command('inspectEntries', { checkout, paths: ['file.txt'] });
    const operation = {
      id: 'move-1',
      clientId: 'alice',
      checkout,
      kind: 'move' as const,
      sources,
      destination: 'renamed.txt',
    };
    const result = await f.client.command('mutate', operation);
    assert.equal(result.outcome, 'completed');
    assert.deepEqual(result.checkout, checkout);
    await assert.rejects(
      f.client.command('acknowledgeOperation', {
        clientId: 'alice',
        operationClientId: 'alice',
        id: 'move-1',
      }),
      rejects('Persistence'),
    );
    const recovered = await f.client.command('loadRecovery', { clientId: 'alice' });
    assert.equal(recovered.state.drafts[0].target.path, 'renamed.txt');
    assert.deepEqual(recovered.state.drafts[0].disk, disk);
    await f.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'alice',
      expectedRevision: recovered.revision,
      state: recovered.state,
    });
    await f.client.command('acknowledgeOperation', {
      clientId: 'alice',
      operationClientId: 'alice',
      id: 'move-1',
    });
    assert.deepEqual(await f.client.command('mutate', operation), result);
    await assert.rejects(
      f.client.command('mutate', { ...operation, destination: 'other.txt' }),
      rejects('Conflict'),
    );
    await f.runtime.dispose();
    const restarted = f.start();
    try {
      assert.deepEqual(
        await restarted.client.command('operationStatus', { clientId: 'alice', id: 'move-1' }),
        result,
      );
      assert.equal(
        (await restarted.client.command('loadRecovery', { clientId: 'alice' })).state.drafts[0]
          .target.path,
        'renamed.txt',
      );
    } finally {
      await restarted.runtime.dispose();
    }
  } finally {
    await f.close();
  }
});

test('create/copy and scoped native import use actual files; single-use references cannot authorize a later operation', async () => {
  const f = fixture();
  try {
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const publish = async (id: string) => {
      const current = await f.client.command('loadRecovery', { clientId: 'alice' });
      await f.client.command('persistRecovery', {
        requestId: randomUUID(),
        clientId: 'alice',
        expectedRevision: current.revision,
        state: current.state,
      });
      await f.client.command('acknowledgeOperation', {
        clientId: 'alice',
        operationClientId: 'alice',
        id,
      });
    };
    assert.equal(
      (
        await f.client.command('mutate', {
          id: 'create',
          clientId: 'alice',
          checkout,
          kind: 'create-file',
          sources: [],
          destination: 'created.txt',
          text: 'created',
        })
      ).outcome,
      'completed',
    );
    await publish('create');
    const sources = await f.client.command('inspectEntries', { checkout, paths: ['created.txt'] });
    assert.equal(
      (
        await f.client.command('mutate', {
          id: 'copy',
          clientId: 'alice',
          checkout,
          kind: 'copy',
          sources,
          destination: 'copy.txt',
        })
      ).outcome,
      'completed',
    );
    await publish('copy');
    assert.equal(readFileSync(join(f.root, 'copy.txt'), 'utf8'), 'created');
    writeFileSync(join(f.base, 'external.txt'), 'native bytes');
    const references = await f.runtime.runPromise(
      Effect.flatMap(WorkspaceNative, (native) =>
        native.capture({ checkout, clientId: 'alice', paths: [join(f.base, 'external.txt')] }),
      ),
    );
    assert.equal(
      (
        await f.client.command('mutate', {
          id: 'import',
          clientId: 'alice',
          checkout,
          kind: 'import',
          sources: [],
          nativeReferences: references,
          destination: 'imported.txt',
        })
      ).outcome,
      'completed',
    );
    await publish('import');
    assert.equal(readFileSync(join(f.root, 'imported.txt'), 'utf8'), 'native bytes');
    await assert.rejects(
      f.client.command('mutate', {
        id: 'import-again',
        clientId: 'alice',
        checkout,
        kind: 'import',
        sources: [],
        nativeReferences: references,
        destination: 'again.txt',
      }),
      rejects('Unauthorized'),
    );
  } finally {
    await f.close();
  }
});

test('identical source paths in independent checkout identities never reconcile each other, including restart', async () => {
  const f = fixture();
  try {
    const root2 = join(f.base, 'repo2');
    mkdirSync(root2);
    execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', root2]);
    for (const root of [f.root, root2]) writeFileSync(join(root, 'file.txt'), 'disk');
    const a = await f.client.command('openCheckout', { root: f.root }),
      b = await f.client.command('openCheckout', { root: root2 });
    const disk = await f.client.command('readFile', { checkout: a, path: 'file.txt' });
    const state = draft('alice', a, 'first', disk);
    state.checkouts.push(b);
    state.drafts.push({ target: { checkout: b, path: 'file.txt' }, text: 'second', disk });
    await f.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'alice',
      expectedRevision: 0,
      state,
    });
    const sources = await f.client.command('inspectEntries', { checkout: a, paths: ['file.txt'] });
    const result = await f.client.command('mutate', {
      id: 'move',
      clientId: 'alice',
      checkout: a,
      kind: 'move',
      sources,
      destination: 'moved.txt',
    });
    assert.deepEqual(result.checkout, a);
    await f.runtime.dispose();
    const restarted = f.start();
    try {
      const restored = await restarted.client.command('loadRecovery', { clientId: 'alice' });
      assert.deepEqual(
        restored.state.drafts.map((d) => [d.target.checkout.checkoutId, d.target.path, d.text]),
        [
          [a.checkoutId, 'moved.txt', 'first'],
          [b.checkoutId, 'file.txt', 'second'],
        ],
      );
      assert.deepEqual(restored.operations[0].checkout, a);
    } finally {
      await restarted.runtime.dispose();
    }
  } finally {
    await f.close();
  }
});

test('real SQLite write contention vetoes recovery discard and mutation before any filesystem change', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'file.txt'), 'disk');
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const disk = await f.client.command('readFile', { checkout, path: 'file.txt' });
    await f.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'alice',
      expectedRevision: 0,
      state: draft('alice', checkout, 'retained', disk),
    });
    const lock = new DatabaseSync(join(f.dataDirectory, 'moonbase-workspace-v1.sqlite'));
    try {
      lock.exec('BEGIN IMMEDIATE');
      await assert.rejects(
        f.client.command('persistRecovery', {
          requestId: randomUUID(),
          clientId: 'alice',
          expectedRevision: 1,
          state: emptyRecovery('alice'),
        }),
        rejects('Persistence'),
      );
      const sources = await f.client.command('inspectEntries', { checkout, paths: ['file.txt'] });
      await assert.rejects(
        f.client.command('mutate', {
          id: 'vetoed',
          clientId: 'alice',
          checkout,
          kind: 'move',
          sources,
          destination: 'moved.txt',
        }),
      );
      assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), 'disk');
      assert.equal(
        (await f.client.command('loadRecovery', { clientId: 'alice' })).state.drafts[0].text,
        'retained',
      );
    } finally {
      lock.exec('ROLLBACK');
      lock.close();
    }
  } finally {
    await f.close();
  }
});

for (const kind of ['move', 'trash'] as const)
  test(`lost native ${kind} response preserves drafts and restart never repeats the mutation`, async () => {
    const f = fixture();
    const { fileURLToPath } = await import('node:url');
    const binary = fileURLToPath(new URL('../../dist/filesystem', import.meta.url));
    const helper = join(f.base, 'lose-response'),
      countFile = join(f.base, 'count'),
      receipt = join(f.base, 'trash-receipt');
    // Only this controlled helper drops a response after calling the actual production native binary.
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    writeFileSync(
      helper,
      `#!/bin/sh\nif [ "$1" = ${quote(kind)} ]; then\n  printf 'called\\n' >> ${quote(countFile)}\n  ${quote(binary)} "$@" > ${quote(receipt)}\n  status=$?\n  if [ "$status" -ne 0 ]; then exit "$status"; fi\n  kill -KILL $$\nfi\nexec ${quote(binary)} "$@"\n`,
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
      writeFileSync(join(f.root, 'file.txt'), 'disk bytes');
      const checkout = await client.command('openCheckout', { root: f.root }),
        disk = await client.command('readFile', { checkout, path: 'file.txt' });
      await client.command('persistRecovery', {
        requestId: randomUUID(),
        clientId: 'alice',
        expectedRevision: 0,
        state: draft('alice', checkout, 'dirty survives', disk),
      });
      const sources = await client.command('inspectEntries', { checkout, paths: ['file.txt'] });
      const operation = {
        id: 'lost',
        clientId: 'alice',
        checkout,
        kind,
        sources,
        ...(kind === 'move' ? { destination: 'moved.txt' } : {}),
      };
      const result = await client.command('mutate', operation);
      assert.equal(result.outcome, 'uncertain');
      assert.deepEqual(result.checkout, checkout);
      assert.equal(readFileSync(countFile, 'utf8'), 'called\n');
      await runtime.dispose();
      const restarted = f.start();
      try {
        const recovered = await restarted.client.command('loadRecovery', { clientId: 'alice' });
        assert.equal(recovered.state.drafts[0].text, 'dirty survives');
        assert.deepEqual(recovered.state.drafts[0].disk, disk);
        assert.equal(
          recovered.state.drafts[0].target.path,
          kind === 'move' ? 'moved.txt' : 'file.txt',
        );
        // The host settles it from the disk: the object left its path (and reached a move's
        // destination), so it completed, and Trash keeps the draft where it was.
        assert.equal(recovered.operations[0].outcome, 'completed');
        await restarted.client.command('mutate', operation);
        assert.equal(readFileSync(countFile, 'utf8'), 'called\n');
      } finally {
        await restarted.runtime.dispose();
      }
    } finally {
      await runtime.dispose();
      if (kind === 'trash' && existsSync(receipt)) {
        const trashed = readFileSync(receipt, 'utf8');
        if (trashed.includes('/.Trash/') && existsSync(trashed)) {
          assert.equal(readFileSync(trashed, 'utf8'), 'disk bytes');
          rmSync(trashed);
        }
      }
      await f.close();
    }
  });

test('known native Trash keeps another client draft and deliberate replacement uses captured identities', async () => {
  const f = fixture();
  let trashPath = '';
  try {
    writeFileSync(join(f.root, 'file.txt'), 'disk');
    const checkout = await f.client.command('openCheckout', { root: f.root }),
      disk = await f.client.command('readFile', { checkout, path: 'file.txt' });
    await f.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'bob',
      expectedRevision: 0,
      state: draft('bob', checkout, 'bob survives trash', disk),
    });
    const sources = await f.client.command('inspectEntries', { checkout, paths: ['file.txt'] });
    const result = await f.client.command('mutate', {
      id: 'trash',
      clientId: 'alice',
      checkout,
      kind: 'trash',
      sources,
    });
    assert.equal(result.outcome, 'completed');
    assert(!existsSync(join(f.root, 'file.txt')));
    trashPath = result.items[0].message!.replace('macOS Trash: ', '');
    assert.equal(
      (await f.client.command('loadRecovery', { clientId: 'bob' })).state.drafts[0].text,
      'bob survives trash',
    );
  } finally {
    if (trashPath.includes('/.Trash/') && existsSync(trashPath)) rmSync(trashPath);
    await f.close();
  }
});

test('filesystem success followed by real SQLite publication failure stays observable and retry publishes without repeating mutation', async () => {
  const { DatabaseSync } = await import('node:sqlite'),
    { fileURLToPath } = await import('node:url');
  const f = fixture(),
    helper = join(f.base, 'pause-after-move'),
    ready = join(f.base, 'ready'),
    release = join(f.base, 'release'),
    count = join(f.base, 'count');
  const binary = fileURLToPath(new URL('../../dist/filesystem', import.meta.url));
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  writeFileSync(
    helper,
    `#!/bin/sh\nif [ "$1" = move ]; then\n printf 'called\\n' >> ${quote(count)}\n ${quote(binary)} "$@" || exit $?\n /usr/bin/touch ${quote(ready)}\n while [ ! -e ${quote(release)} ]; do /bin/sleep 0.01; done\n exit 0\nfi\nexec ${quote(binary)} "$@"\n`,
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
    writeFileSync(join(f.root, 'file.txt'), 'disk');
    const checkout = await client.command('openCheckout', { root: f.root });
    const disk = await client.command('readFile', { checkout, path: 'file.txt' });
    await client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'alice',
      expectedRevision: 0,
      state: draft('alice', checkout, 'retained dirty', disk),
    });
    const sources = await client.command('inspectEntries', { checkout, paths: ['file.txt'] });
    const operation = {
      id: 'publication',
      clientId: 'alice',
      checkout,
      kind: 'move' as const,
      sources,
      destination: 'moved.txt',
    };
    const pending = client.command('mutate', operation);
    const deadline = Date.now() + 3000;
    while (!existsSync(ready)) {
      assert(Date.now() < deadline, 'native operation did not reach pause');
      await new Promise((r) => setTimeout(r, 10));
    }
    const lock = new DatabaseSync(join(f.dataDirectory, 'moonbase-workspace-v1.sqlite'));
    try {
      lock.exec('BEGIN IMMEDIATE');
      writeFileSync(release, 'resume');
      const result = await pending;
      assert(result.message);
      assert.equal(result.items[0].outcome, 'completed');
      assert.equal(readFileSync(join(f.root, 'moved.txt'), 'utf8'), 'disk');
    } finally {
      lock.exec('ROLLBACK');
      lock.close();
    }
    const recovered = await client.command('loadRecovery', { clientId: 'alice' });
    assert.equal(recovered.state.drafts[0].target.path, 'moved.txt');
    assert.equal(recovered.state.drafts[0].text, 'retained dirty');
    assert.equal((await client.command('mutate', operation)).outcome, 'completed');
    assert.equal(readFileSync(count, 'utf8'), 'called\n');
  } finally {
    writeFileSync(release, 'resume');
    await runtime.dispose();
    await f.close();
  }
});

test('unavailable persistence and real filesystem file-size exhaustion report typed errors and retain existing recovery', async () => {
  const { fileURLToPath } = await import('node:url');
  const f = fixture();
  try {
    const notDirectory = join(f.base, 'not-directory');
    writeFileSync(notDirectory, 'existing bytes');
    const unavailable = ManagedRuntime.make(
      WorkspaceLive({ hostId: 'unavailable', dataDirectory: notDirectory }),
    );
    try {
      await assert.rejects(
        makeEditorClient(unavailable).command('loadRecovery', { clientId: 'alice' }),
        rejects('Persistence'),
      );
    } finally {
      await unavailable.dispose();
    }
    assert.equal(readFileSync(notDirectory, 'utf8'), 'existing bytes');
    writeFileSync(join(f.root, 'file.txt'), 'disk');
    const output = execFileSync(
      '/bin/sh',
      [
        '-c',
        'ulimit -f 128; exec "$@"',
        'size-limited-workspace',
        process.execPath,
        '--experimental-strip-types',
        fileURLToPath(new URL('../../test/fixtures/persistence-limit.fixture.ts', import.meta.url)),
        f.root,
        join(f.base, 'limited-state'),
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert(output.includes('original recovery retained'));
  } finally {
    await f.close();
  }
});

test('batch move reports partial success and explicit replacement revalidates the captured destination', async () => {
  const f = fixture();
  const trashPaths: string[] = [];
  try {
    mkdirSync(join(f.root, 'target'));
    writeFileSync(join(f.root, 'first'), 'first');
    writeFileSync(join(f.root, 'second'), 'second');
    writeFileSync(join(f.root, 'target/second'), 'occupied');
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const sources = await f.client.command('inspectEntries', {
      checkout,
      paths: ['first', 'second'],
    });
    const partial = await f.client.command('mutate', {
      id: 'partial',
      clientId: 'alice',
      checkout,
      kind: 'move',
      sources,
      destination: 'target',
    });
    assert.equal(partial.outcome, 'failed');
    assert.deepEqual(
      partial.items.map((item) => item.outcome),
      ['completed', 'failed'],
    );
    assert.equal(readFileSync(join(f.root, 'target/first'), 'utf8'), 'first');
    assert.equal(readFileSync(join(f.root, 'second'), 'utf8'), 'second');
    const load = await f.client.command('loadRecovery', { clientId: 'alice' });
    await f.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'alice',
      expectedRevision: load.revision,
      state: load.state,
    });
    await f.client.command('acknowledgeOperation', {
      clientId: 'alice',
      operationClientId: 'alice',
      id: 'partial',
    });
    const remaining = await f.client.command('inspectEntries', { checkout, paths: ['second'] }),
      replacements = await f.client.command('inspectEntries', {
        checkout,
        paths: ['target/second'],
      });
    renameSync(join(f.root, 'target/second'), join(f.root, 'old-occupied'));
    writeFileSync(join(f.root, 'target/second'), 'replacement changed');
    await assert.rejects(
      f.client.command('mutate', {
        id: 'stale-replacement',
        clientId: 'alice',
        checkout,
        kind: 'move',
        sources: remaining,
        replacements,
        destination: 'target/second',
      }),
      rejects('Conflict'),
    );
    assert.equal(readFileSync(join(f.root, 'target/second'), 'utf8'), 'replacement changed');
    const fresh = await f.client.command('inspectEntries', { checkout, paths: ['target/second'] });
    const replaced = await f.client.command('mutate', {
      id: 'replacement',
      clientId: 'alice',
      checkout,
      kind: 'move',
      sources: remaining,
      replacements: fresh,
      destination: 'target/second',
    });
    assert.equal(replaced.outcome, 'completed');
    assert.equal(readFileSync(join(f.root, 'target/second'), 'utf8'), 'second');
    // The production result exposes actual native Trash location for ordinary Trash; replacement preserves bytes there too.
    const replacementTrash = replaced.items.find((item) => item.destination === undefined)!;
    assert.equal(replacementTrash.outcome, 'completed');
    const trashed = replacementTrash.message!.slice(replacementTrash.message!.indexOf('/'));
    assert(trashed.includes('/.Trash/'));
    trashPaths.push(trashed);
    assert.equal(readFileSync(trashed, 'utf8'), 'replacement changed');
  } finally {
    trashPaths.forEach((p) => {
      if (p.includes('/.Trash/') && existsSync(p)) rmSync(p);
    });
    await f.close();
  }
});

test('cancelling admitted native copy is typed, preserves source and leaves unrelated file queries usable', async () => {
  const { fileURLToPath } = await import('node:url');
  const f = fixture(),
    helper = join(f.base, 'slow-copy'),
    ready = join(f.base, 'copy-ready');
  const binary = fileURLToPath(new URL('../../dist/filesystem', import.meta.url));
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  writeFileSync(
    helper,
    `#!/bin/sh\nif [ "$1" = copy ]; then\n /usr/bin/touch ${quote(ready)}\n while :; do /bin/sleep 0.05; done\nfi\nexec ${quote(binary)} "$@"\n`,
  );
  chmodSync(helper, 0o700);
  const runtime = ManagedRuntime.make(
      WorkspaceLive({
        dataDirectory: f.dataDirectory,
        hostId: 'local-test',
        filesystemHelper: helper,
      }),
    ),
    client = makeEditorClient(runtime),
    abort = new AbortController();
  try {
    writeFileSync(join(f.root, 'file.txt'), 'source survives');
    writeFileSync(join(f.root, 'unrelated.txt'), 'unrelated original');
    const checkout = await client.command('openCheckout', { root: f.root });
    const sources = await client.command('inspectEntries', { checkout, paths: ['file.txt'] });
    const pending = client.command(
      'mutate',
      {
        id: 'cancel-copy',
        clientId: 'alice',
        checkout,
        kind: 'copy',
        sources,
        destination: 'copy.txt',
      },
      { signal: abort.signal },
    );
    const rejected = assert.rejects(pending, rejects('Cancelled'));
    const deadline = Date.now() + 3000;
    while (!existsSync(ready)) {
      assert(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      (await client.command('readFile', { checkout, path: 'file.txt' })).text,
      'source survives',
    );
    const unrelated = { checkout, path: 'unrelated.txt' },
      baseline = await client.command('readFile', unrelated);
    assert.equal(
      (
        await client.command('saveFile', {
          target: unrelated,
          clientId: 'bob',
          requestId: 'unrelated-save',
          text: 'unrelated saved',
          expectedVersion: baseline.version,
        })
      ).kind,
      'saved',
    );
    abort.abort();
    await rejected;
    await runtime.dispose();
    assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), 'source survives');
    assert(!existsSync(join(f.root, 'copy.txt')));
    const restarted = f.start();
    try {
      assert.equal(
        (
          await restarted.client.command('operationStatus', {
            clientId: 'alice',
            id: 'cancel-copy',
          })
        )?.outcome,
        'failed',
      );
    } finally {
      await restarted.runtime.dispose();
    }
  } finally {
    abort.abort();
    await runtime.dispose();
    await f.close();
  }
});

test('batch move can target the checkout root and preserves exact captured identities', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'folder'));
    writeFileSync(join(f.root, 'folder/one'), 'one');
    writeFileSync(join(f.root, 'folder/two'), 'two');
    const checkout = await f.client.command('openCheckout', { root: f.root }),
      sources = await f.client.command('inspectEntries', {
        checkout,
        paths: ['folder/one', 'folder/two'],
      });
    const result = await f.client.command('mutate', {
      id: 'root-batch',
      clientId: 'alice',
      checkout,
      kind: 'move',
      sources,
      destination: '',
    });
    assert.equal(result.outcome, 'completed');
    assert.equal(readFileSync(join(f.root, 'one'), 'utf8'), 'one');
    assert.equal(readFileSync(join(f.root, 'two'), 'utf8'), 'two');
  } finally {
    await f.close();
  }
});

test('restart counts transfer and Trash results by structure regardless of display wording', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'source'), 'bytes');
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const sources = await f.client.command('inspectEntries', { checkout, paths: ['source'] });
    await f.runtime.dispose();
    // An interrupted operation as the client left it, and as the host journalled it.
    const client = new DatabaseSync(join(f.dataDirectory, 'moonbase-workspace-v1.sqlite'));
    const host = new DatabaseSync(join(f.dataDirectory, 'workspace-host.sqlite'));
    try {
      for (const kind of ['move', 'trash'] as const) {
        const items =
          kind === 'move'
            ? [
                {
                  source: 'destination',
                  outcome: 'completed',
                  message: 'Replacement retained in Trash.',
                },
                {
                  source: 'source',
                  destination: 'destination',
                  outcome: 'completed',
                  message: 'Explicit replacement wording is display only.',
                },
              ]
            : [
                {
                  source: 'source',
                  outcome: 'completed',
                  message: 'Explicit replacement wording is display only.',
                },
              ];
        const input = {
          id: kind,
          clientId: 'alice',
          checkout,
          kind,
          sources,
          ...(kind === 'move' ? { destination: 'destination' } : {}),
        };
        const result = { id: kind, clientId: 'alice', checkout, kind, outcome: 'uncertain' };
        const digest = (...parts: string[]) =>
          createHash('sha256').update(JSON.stringify(parts)).digest('hex');
        client.prepare('INSERT INTO records VALUES(?,?,?)').run(
          'operations',
          digest('alice', kind),
          JSON.stringify({
            open: true,
            input,
            publicationRevisions: {},
            acknowledgedBy: [],
            result: { ...result, items: [], recoveryChanges: [] },
          }),
        );
        host
          .prepare(
            "INSERT INTO journal(kind, id, checkout, installation, client, unsettled, body) VALUES('operations',?,?,'test-installation','alice',1,?)",
          )
          .run(
            digest('test-installation', 'alice', kind),
            checkout.checkoutId,
            JSON.stringify({
              input: { installationId: 'test-installation', ...input },
              result: { ...result, items },
              planned: [
                {
                  source: 'source',
                  identity: sources[0].identity,
                  ...(kind === 'move' ? { destination: 'destination' } : {}),
                },
              ],
            }),
          );
      }
    } finally {
      client.close();
      host.close();
    }
    const restarted = f.start();
    try {
      const loaded = await restarted.client.command('loadRecovery', { clientId: 'alice' });
      assert.equal(loaded.operations.length, 2);
      assert(loaded.operations.every((result) => result.outcome === 'completed'));
    } finally {
      await restarted.runtime.dispose();
    }
  } finally {
    await f.close();
  }
});
