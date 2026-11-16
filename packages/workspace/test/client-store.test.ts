import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openOperations, pendingSaves } from '../src/client/client-store.ts';
import { fixture as recoveryFixture, isError } from './recovery-fixture.ts';

function fixture() {
  const f = recoveryFixture();
  writeFileSync(join(f.root, 'a.txt'), 'original');
  return {
    ...f,
    database: () => new DatabaseSync(join(f.base, 'state', 'moonbase-workspace-v1.sqlite')),
  };
}

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
      if (value?.request?.requestId?.startsWith('large-')) historyBytes += body.length;
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
