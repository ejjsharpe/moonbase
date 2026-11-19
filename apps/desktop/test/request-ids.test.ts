import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Effect } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { getErrorGroup } from '@moonbase/contracts/error-groups';
import { makeFileRequestIds } from '../src/main/request-ids.ts';

test('a corrupt request store fails each request instead of issuing a new ID', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moonbase-request-ids-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'chat-requests.json');
  await writeFile(file, '{not json');
  const failure = await Effect.runPromise(
    Effect.gen(function* () {
      const ids = yield* makeFileRequestIds(file);
      return yield* Effect.flip(ids.issue('k'));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  assert.equal(getErrorGroup(failure), 'storage');
  assert.equal(await readFile(file, 'utf8'), '{not json');
});
