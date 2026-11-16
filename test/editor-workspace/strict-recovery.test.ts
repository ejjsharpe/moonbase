import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EditorClient } from '@moonbase/contracts/workspace';
import { code, fixture, listDrafts } from './editor-workspace-fixture.ts';

test('a stored recovery of an unknown format fails to load, the editor refuses to load, and the row stays untouched', async () => {
  const f = fixture();
  try {
    const writer = await f.editor('strict-editor'),
      checkout = await writer.openCheckout(f.roots[0]),
      target = { checkout, path: 'b.ts' };
    await writer.open(target);
    writer.edit(target, 'irreplaceable draft');
    await writer.flush();
    const stored = await f.loadRecovery('strict-editor');
    assert.equal(listDrafts(stored)['b.ts']?.text, 'irreplaceable draft');
    const restarted = await f.restart();

    // A row a newer or older producer wrote: a version-2 body with a field this one doesn't know.
    const database = new DatabaseSync(join(f.dataDirectory, 'moonbase-workspace-v1.sqlite'));
    try {
      const unknown = {
        ...stored,
        buffers: stored.buffers.map((buffer) =>
          buffer.draft
            ? { ...buffer, draft: { ...buffer.draft, futureMetadata: { note: 1 } } }
            : buffer,
        ),
      };
      database
        .prepare('UPDATE recovery SET body=? WHERE client=?')
        .run(JSON.stringify(unknown), 'strict-editor');
      const rows = () => ({
        recovery: database.prepare('SELECT client,revision,body FROM recovery').all(),
        records: database.prepare('SELECT bucket,key,body FROM records ORDER BY bucket,key').all(),
      });
      const before = rows();

      await assert.rejects(
        restarted.client.command('loadRecovery', { clientId: 'strict-editor' }),
        code('Persistence'),
      );
      let writes = 0;
      const observed: EditorClient = {
        ...restarted.client,
        command(name, input, options) {
          if (
            ['openTab', 'closeTab', 'updateDraft', 'updateLayout', 'saveFile', 'mutate'].includes(
              name,
            )
          )
            writes++;
          return restarted.client.command(name, input, options);
        },
      };
      await assert.rejects(f.editor('strict-editor', observed), code('Persistence'));
      // An edit sent anyway is refused, not written over the row.
      await assert.rejects(
        restarted.client.command('updateDraft', {
          clientId: 'strict-editor',
          bufferId: stored.buffers[0].id,
          text: 'overwrite',
          disk: listDrafts(stored)['b.ts']!.disk,
        }),
        code('Persistence'),
      );
      assert.equal(writes, 0);
      assert.deepEqual(rows(), before);
      assert.equal(readFileSync(join(f.roots[0], 'b.ts'), 'utf8'), 'B\n');

      await f.restart();
      await assert.rejects(f.loadRecovery('strict-editor'), code('Persistence'));
      assert.deepEqual(rows(), before);
    } finally {
      database.close();
    }
  } finally {
    await f.close();
  }
});
