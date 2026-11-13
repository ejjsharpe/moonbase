import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { createStorageConformance } from '@earendil-works/pi-durable/testing';

// The runtime stores chats through chord's node:sqlite adapter on Node, Electron and Bun alike, so
// a runtime or chord upgrade that breaks Pi Durable storage fails here first.
const cases = createStorageConformance({
  assertions: {
    ok: (value, message) => assert.ok(value, message ?? 'Expected a truthy value'),
    strictEqual: (actual, expected) => assert.strictEqual(actual, expected),
    deepEqual: (actual, expected) => assert.deepStrictEqual(actual, expected),
    partialDeepEqual: (actual, expected) => assert.partialDeepStrictEqual(actual, expected),
    greaterThan: (actual, expected) => assert.ok(actual > expected, `${actual} > ${expected}`),
    rejects: (operation, messageIncludes) =>
      assert.rejects(operation, (error: Error) => error.message.includes(messageIncludes)),
  },
  withStorage: async (run) => {
    const directory = await mkdtemp(join(tmpdir(), 'moonbase-storage-conformance-'));
    try {
      // The runtime's own settings for its store.
      const database = await openNodeSqliteDatabase(join(directory, 'chat.sqlite'), {
        busyTimeoutMs: 30,
      });
      const storage = await SqliteStorage.open(database);
      try {
        await run(storage);
      } finally {
        await storage.close(context);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
});

for (const conformance of cases)
  test(`Pi Durable storage conformance on ${runtimeName()}: ${conformance.name}`, () =>
    conformance.run());

function runtimeName() {
  return process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`;
}
