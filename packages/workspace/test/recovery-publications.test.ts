import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { ApplicationError, emptyRecovery, type CommandInput } from '@moonbase/contracts/workspace';
import { WorkspaceService } from '@moonbase/contracts/services';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import { openOperations, pendingSaves } from '../src/client-store.ts';
import { WorkspaceLive } from './workspace-live.ts';
const binary = fileURLToPath(new URL('../dist/filesystem', import.meta.url));
const isError = (code: ApplicationError['code']) => (e: unknown) =>
  ApplicationError.is(e) && e.code === code;
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moonbase-publications-'))),
    root = join(base, 'repo'),
    dataDirectory = join(base, 'state');
  mkdirSync(root);
  execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', root]);
  writeFileSync(join(root, 'a.txt'), 'original');
  writeFileSync(join(root, 'b.txt'), 'original');
  const start = (
    hold?: {
      phase: 'before' | 'after';
      requestId: string;
      entered: ReturnType<typeof barrier>;
      release: ReturnType<typeof barrier>;
    },
    filesystemHelper = binary,
  ) => {
    let layer = WorkspaceLive({ dataDirectory, hostId: 'publication-host', filesystemHelper });
    if (hold)
      layer = Layer.effect(
        WorkspaceService,
        Effect.map(WorkspaceService, (actual) => ({
          ...actual,
          persistRecovery: (input) => {
            const wait = Effect.promise(() => {
              hold.entered.resolve();
              return hold.release.promise;
            });
            if (input.requestId !== hold.requestId) return actual.persistRecovery(input);
            if (hold.phase === 'before')
              return Effect.flatMap(wait, () => actual.persistRecovery(input));
            return Effect.tap(actual.persistRecovery(input), () => wait);
          },
        })),
      ).pipe(Layer.provide(layer)) as typeof layer;
    const runtime = ManagedRuntime.make(layer);
    return { runtime, client: makeEditorClient(runtime) };
  };
  return {
    base,
    root,
    start,
    database: () => new DatabaseSync(join(dataDirectory, 'moonbase-workspace-v1.sqlite')),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}
async function snapshot(client: ReturnType<typeof makeEditorClient>, root: string) {
  const checkout = await client.command('openCheckout', { root }),
    target = { checkout, path: 'a.txt' },
    disk = await client.command('readFile', target);
  return {
    ...emptyRecovery('alice'),
    checkouts: [checkout],
    openCheckoutIds: [checkout.checkoutId],
    drafts: [{ target, text: 'captured draft', disk }],
  };
}

test('publication receipt resolves a response lost after commit despite a later competing publication and restart', async () => {
  const f = fixture(),
    entered = barrier(),
    release = barrier();
  let current = f.start({ phase: 'after', requestId: 'lost', entered, release });
  try {
    const state = await snapshot(current.client, f.root),
      input = { clientId: 'alice', requestId: 'lost', expectedRevision: 0, state };
    const controller = new AbortController(),
      pending = current.client.command('persistRecovery', input, { signal: controller.signal });
    void pending.catch(() => {});
    await entered.promise;
    const original = { clientId: 'alice', requestId: 'lost', previousRevision: 0, revision: 1 };
    assert.deepEqual(
      await current.client.command('getRecoveryPublication', {
        clientId: 'alice',
        requestId: 'lost',
      }),
      original,
    );
    const later = {
      ...state,
      drafts: state.drafts.map((d) => ({ ...d, text: 'newer competing draft' })),
    };
    assert.deepEqual(
      await current.client.command('persistRecovery', {
        clientId: 'alice',
        requestId: 'later',
        expectedRevision: 1,
        state: later,
      }),
      { ...original, requestId: 'later', previousRevision: 1, revision: 2 },
    );
    controller.abort();
    await assert.rejects(pending, isError('Cancelled'));
    release.resolve();
    for (let restart = 0; restart < 2; restart++) {
      await current.runtime.dispose();
      current = f.start();
      const [receipt, retried] = await Promise.all([
        current.client.command('getRecoveryPublication', { clientId: 'alice', requestId: 'lost' }),
        current.client.command('persistRecovery', input),
      ]);
      assert.deepEqual(receipt, original);
      assert.deepEqual(retried, original);
      const loaded = await current.client.command('loadRecovery', { clientId: 'alice' });
      assert.equal(loaded.revision, 2);
      assert.deepEqual(loaded.state, later);
    }
  } finally {
    release.resolve();
    await current.runtime.dispose();
    f.cleanup();
  }
});

test('publication IDs bind full canonical inputs and isolate client namespaces', async () => {
  const f = fixture(),
    { runtime, client } = f.start();
  try {
    const state = await snapshot(client, f.root),
      input = { clientId: 'alice', requestId: 'immutable', expectedRevision: 0, state };
    assert.equal(
      await client.command('getRecoveryPublication', { clientId: 'alice', requestId: 'unknown' }),
      null,
    );
    const receipt = await client.command('persistRecovery', input);
    assert.deepEqual(receipt, {
      clientId: 'alice',
      requestId: 'immutable',
      previousRevision: 0,
      revision: 1,
    });
    const reordered = { state, expectedRevision: 0, requestId: 'immutable', clientId: 'alice' };
    assert.deepEqual(await client.command('persistRecovery', reordered), receipt);
    const otherCheckout = { ...state.checkouts[0], hostId: 'unapproved-host' };
    const otherTarget = {
      ...state,
      checkouts: [otherCheckout],
      drafts: state.drafts.map((d) => ({ ...d, target: { ...d.target, checkout: otherCheckout } })),
    };
    for (const changed of [
      { ...input, expectedRevision: 1 },
      { ...input, state: { ...state, drafts: [] } },
      { ...input, state: otherTarget },
    ])
      await assert.rejects(client.command('persistRecovery', changed), isError('InvalidInput'));
    await assert.rejects(
      client.command('persistRecovery', { ...input, requestId: 'unapproved', state: otherTarget }),
      isError('Unauthorized'),
    );
    await assert.rejects(
      client.command('persistRecovery', { ...input, requestId: 'different' }),
      isError('Conflict'),
    );
    assert.equal(
      await client.command('getRecoveryPublication', { clientId: 'alice', requestId: 'different' }),
      null,
    );
    assert.equal(
      await client.command('getRecoveryPublication', { clientId: 'bob', requestId: 'immutable' }),
      null,
    );
    await assert.rejects(
      client.command('persistRecovery', { ...input, clientId: 'bob' }),
      isError('InvalidInput'),
    );
    const bob = await client.command('persistRecovery', {
      ...input,
      clientId: 'bob',
      state: { ...state, clientId: 'bob' },
    });
    assert.deepEqual(bob, { ...receipt, clientId: 'bob' });
    receipt.revision = 999;
    assert.equal(
      (
        await client.command('getRecoveryPublication', {
          clientId: 'alice',
          requestId: 'immutable',
        })
      )?.revision,
      1,
    );
    assert.equal((await client.command('loadRecovery', { clientId: 'alice' })).revision, 1);
    await assert.rejects(
      client.command('getRecoveryPublication', { clientId: 'alice', requestId: '' }),
      isError('InvalidInput'),
    );
  } finally {
    await runtime.dispose();
    f.cleanup();
  }
});

test('cancellation before publication commit creates no receipt and retains the prior snapshot', async () => {
  const f = fixture(),
    entered = barrier(),
    release = barrier(),
    { runtime, client } = f.start({ phase: 'before', requestId: 'cancelled', entered, release });
  try {
    const state = await snapshot(client, f.root),
      controller = new AbortController();
    const pending = client.command(
      'persistRecovery',
      { clientId: 'alice', requestId: 'cancelled', expectedRevision: 0, state },
      { signal: controller.signal },
    );
    void pending.catch(() => {});
    await entered.promise;
    controller.abort();
    await assert.rejects(pending, isError('Cancelled'));
    release.resolve();
    assert.equal(
      await client.command('getRecoveryPublication', { clientId: 'alice', requestId: 'cancelled' }),
      null,
    );
    const loaded = await client.command('loadRecovery', { clientId: 'alice' });
    assert.equal(loaded.revision, 0);
    assert.deepEqual(loaded.state, emptyRecovery('alice'));
  } finally {
    release.resolve();
    await runtime.dispose();
    f.cleanup();
  }
});

test('real SQLite contention before commit leaves no publication receipt and original retry commits once', async () => {
  const f = fixture(),
    { runtime, client } = f.start();
  try {
    const state = await snapshot(client, f.root),
      input = { clientId: 'alice', requestId: 'locked', expectedRevision: 0, state },
      lock = f.database();
    try {
      lock.exec('BEGIN IMMEDIATE');
      await assert.rejects(client.command('persistRecovery', input), isError('Persistence'));
    } finally {
      lock.exec('ROLLBACK');
      lock.close();
    }
    assert.equal(
      await client.command('getRecoveryPublication', { clientId: 'alice', requestId: 'locked' }),
      null,
    );
    assert.equal((await client.command('loadRecovery', { clientId: 'alice' })).revision, 0);
    const receipts = await Promise.all([
      client.command('persistRecovery', input),
      client.command('persistRecovery', input),
    ]);
    assert.deepEqual(receipts[0], {
      clientId: 'alice',
      requestId: 'locked',
      previousRevision: 0,
      revision: 1,
    });
    assert.deepEqual(receipts[1], receipts[0]);
    const contention = f.database();
    try {
      contention.exec('BEGIN IMMEDIATE');
      assert.deepEqual(await client.command('persistRecovery', input), receipts[0]);
      assert.deepEqual(
        await client.command('getRecoveryPublication', { clientId: 'alice', requestId: 'locked' }),
        receipts[0],
      );
      await assert.rejects(
        client.command('persistRecovery', { ...input, expectedRevision: 1 }),
        isError('InvalidInput'),
      );
    } finally {
      contention.exec('ROLLBACK');
      contention.close();
    }
  } finally {
    await runtime.dispose();
    f.cleanup();
  }
});

test('receipt insertion failure rolls back recovery snapshot and explicit publication fence together', async () => {
  const f = fixture(),
    { runtime, client } = f.start();
  try {
    const state = await snapshot(client, f.root),
      checkout = state.checkouts[0];
    await client.command('persistRecovery', {
      clientId: 'alice',
      requestId: 'seed',
      expectedRevision: 0,
      state,
    });
    const sources = await client.command('inspectEntries', { checkout, paths: ['a.txt'] });
    await client.command('mutate', {
      clientId: 'alice',
      id: 'move',
      checkout,
      kind: 'move',
      sources,
      destination: 'moved.txt',
    });
    const before = await client.command('loadRecovery', { clientId: 'alice' });
    const input = {
        clientId: 'alice',
        requestId: 'failed-row',
        expectedRevision: before.revision,
        state: { ...before.state, drafts: [] },
      },
      db = f.database();
    try {
      db.exec(
        "CREATE TRIGGER fail_receipt BEFORE INSERT ON records WHEN NEW.bucket='recovery-publications' BEGIN SELECT RAISE(FAIL, 'test receipt storage unavailable'); END;",
      );
      await assert.rejects(client.command('persistRecovery', input), isError('Persistence'));
      assert.equal(
        await client.command('getRecoveryPublication', {
          clientId: 'alice',
          requestId: 'failed-row',
        }),
        null,
      );
      const loaded = await client.command('loadRecovery', { clientId: 'alice' });
      assert.equal(loaded.revision, 2);
      assert.deepEqual(loaded.state, before.state);
      await assert.rejects(
        client.command('acknowledgeOperation', {
          clientId: 'alice',
          operationClientId: 'alice',
          id: 'move',
        }),
        isError('Persistence'),
      );
      db.exec('DROP TRIGGER fail_receipt');
      assert.deepEqual(await client.command('persistRecovery', input), {
        clientId: 'alice',
        requestId: 'failed-row',
        previousRevision: 2,
        revision: 3,
      });
      await client.command('acknowledgeOperation', {
        clientId: 'alice',
        operationClientId: 'alice',
        id: 'move',
      });
    } finally {
      db.close();
    }
  } finally {
    await runtime.dispose();
    f.cleanup();
  }
});

test('matching receipt replay precedes later uncertain-operation preservation guards', async () => {
  const f = fixture(),
    helper = join(f.base, 'helper');
  writeFileSync(
    helper,
    '#!/bin/sh\nif [ "$1" = move ]; then kill -KILL $$; fi\nexec "' + binary + '" "$@"\n',
  );
  chmodSync(helper, 0o700);
  const { runtime, client } = f.start(undefined, helper);
  try {
    const state = await snapshot(client, f.root),
      initial: CommandInput<'persistRecovery'> = {
        clientId: 'alice',
        requestId: 'before-draft',
        expectedRevision: 0,
        state: { ...state, drafts: [] },
      };
    const receipt = await client.command('persistRecovery', initial);
    await client.command('persistRecovery', {
      clientId: 'alice',
      requestId: 'dirty',
      expectedRevision: 1,
      state,
    });
    const checkout = state.checkouts[0],
      sources = await client.command('inspectEntries', { checkout, paths: ['a.txt'] });
    assert.equal(
      (
        await client.command('mutate', {
          clientId: 'alice',
          id: 'uncertain',
          checkout,
          kind: 'move',
          sources,
          destination: 'moved.txt',
        })
      ).outcome,
      'uncertain',
    );
    assert.deepEqual(await client.command('persistRecovery', initial), receipt);
    const loaded = await client.command('loadRecovery', { clientId: 'alice' });
    assert.equal(loaded.revision, 2);
    assert.deepEqual(loaded.state, state);
  } finally {
    await runtime.dispose();
    f.cleanup();
  }
});

test('growing settled Save history is not parsed by later Save or recovery load', async () => {
  const f = fixture();
  const { runtime, client } = f.start();
  try {
    const checkout = await client.command('openCheckout', { root: f.root });
    const target = { checkout, path: 'a.txt' };
    let disk = await client.command('readFile', target);
    const inputs = [];
    for (let i = 0; i < 12; i++) {
      const input = {
        target,
        clientId: 'alice',
        requestId: `large-${i}`,
        text: String(i) + 'x'.repeat(256 * 1024),
        expectedVersion: disk.version,
      };
      const result = await client.command('saveFile', input);
      assert.equal(result.kind, 'saved');
      disk = result.disk;
      inputs.push({ input, result });
    }
    const database = f.database();
    try {
      const plan = database
        .prepare(
          `EXPLAIN QUERY PLAN SELECT body FROM records WHERE bucket=? AND ${pendingSaves} ORDER BY rowid`,
        )
        .all('saves');
      assert.ok(
        plan.some((row) => String(row.detail).includes('pending_saves')),
        'pending reads must use the partial index rather than scan settled text in SQLite',
      );
      const operations = database
        .prepare(
          `EXPLAIN QUERY PLAN SELECT body FROM records WHERE bucket=? AND ${openOperations} ORDER BY rowid`,
        )
        .all('operations');
      assert.ok(operations.some((row) => String(row.detail).includes('open_operations')));
    } finally {
      database.close();
    }
    const parse = JSON.parse;
    let historyBytes = 0;
    JSON.parse = (body, ...args) => {
      const value = parse(body, ...args);
      if (value?.input?.requestId?.startsWith('large-')) historyBytes += body.length;
      return value;
    };
    try {
      await client.command('saveFile', {
        target,
        clientId: 'alice',
        requestId: 'next',
        text: 'next',
        expectedVersion: disk.version,
      });
      await client.command('loadRecovery', { clientId: 'alice' });
    } finally {
      JSON.parse = parse;
    }
    assert.equal(historyBytes, 0, 'settled Save bodies must be filtered before JSON.parse');
    await runtime.dispose();
    const restarted = f.start();
    try {
      assert.deepEqual(
        await restarted.client.command('saveFile', inputs[0].input),
        inputs[0].result,
      );
      await assert.rejects(
        restarted.client.command('saveFile', { ...inputs[0].input, text: 'changed' }),
        isError('Conflict'),
      );
    } finally {
      await restarted.runtime.dispose();
    }
  } finally {
    await runtime.dispose();
    f.cleanup();
  }
});

test('completed conflict history is not parsed by recovery and replays exactly after restart', async () => {
  const f = fixture();
  const { runtime, client } = f.start();
  try {
    const checkout = await client.command('openCheckout', { root: f.root });
    const target = { checkout, path: 'a.txt' };
    const disk = await client.command('readFile', target);
    writeFileSync(join(f.root, 'a.txt'), 'external writer');
    const inputs = [];
    for (let i = 0; i < 3; i++) {
      const input = {
        target,
        clientId: 'alice',
        requestId: `conflict-history-${i}`,
        text: String(i) + 'x'.repeat(256 * 1024),
        expectedVersion: disk.version,
      };
      const result = await client.command('saveFile', input);
      assert.equal(result.kind, 'conflict');
      inputs.push({ input, result });
    }
    const parse = JSON.parse;
    let historyBytes = 0;
    JSON.parse = (body, ...args) => {
      const value = parse(body, ...args);
      if (value?.input?.requestId?.startsWith('conflict-history-')) historyBytes += body.length;
      return value;
    };
    try {
      await client.command('loadRecovery', { clientId: 'alice' });
      await client.command('loadRecovery', { clientId: 'bob' });
    } finally {
      JSON.parse = parse;
    }
    assert.equal(historyBytes, 0, 'completed conflict bodies must be filtered before JSON.parse');
    await runtime.dispose();
    const restarted = f.start();
    try {
      assert.deepEqual(
        await restarted.client.command('saveFile', inputs[0].input),
        inputs[0].result,
      );
      await assert.rejects(
        restarted.client.command('saveFile', { ...inputs[0].input, text: 'changed' }),
        isError('Conflict'),
      );
    } finally {
      await restarted.runtime.dispose();
    }
  } finally {
    await runtime.dispose();
    f.cleanup();
  }
});
