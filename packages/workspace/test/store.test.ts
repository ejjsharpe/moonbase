import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { Store } from '../src/store.ts';

const rounds = 20;
test('concurrent transactions and plain writes on one store neither collide nor lose writes', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moonbase-store-')));
  const store = new Store(base, {
    file: 'test.sqlite',
    applicationId: 1,
    schema: '',
    decoders: { rows: (value) => value },
  });
  try {
    // Eight fibers interleave on the one connection; a transaction that yielded inside itself
    // would collide at once, so a few rounds each are enough.
    const workers = Array.from({ length: 8 }, (_, worker) =>
      Effect.forEach(
        Array.from({ length: rounds }, (_, index) => index),
        (index) =>
          Effect.gen(function* () {
            yield* store.transaction(() => store.put('rows', `t-${worker}-${index}`, index));
            // A plain write between transactions, and a transaction that fails and rolls back.
            yield* Effect.sync(() => store.put('rows', `p-${worker}-${index}`, index));
            yield* Effect.exit(
              store.transaction(() => {
                store.put('rows', `rolled-${worker}-${index}`, index);
                throw new Error('refused');
              }),
            );
          }),
        { discard: true },
      ),
    );
    await Effect.runPromise(Effect.all(workers, { concurrency: 8, discard: true }));
    const keys = store.db
      .prepare("SELECT key FROM records WHERE bucket='rows'")
      .all()
      .map((row) => row.key as string);
    assert.equal(keys.filter((key) => key.startsWith('t-')).length, 8 * rounds);
    assert.equal(keys.filter((key) => key.startsWith('p-')).length, 8 * rounds);
    assert.equal(keys.filter((key) => key.startsWith('rolled-')).length, 0);
  } finally {
    store.close();
    rmSync(base, { recursive: true, force: true });
  }
});
