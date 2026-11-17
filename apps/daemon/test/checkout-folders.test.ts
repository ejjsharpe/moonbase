import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Effect } from 'effect';
import { withCheckoutFolders } from '../src/checkout-folders.ts';
import { createFolderApprovals, promised, temporaryFolder } from './folders-fixture.ts';

test('checkout folders widen what chats may use without becoming picker grants', async () => {
  const root = await temporaryFolder('moonbase-folders-');
  try {
    const [picked, project, other] = ['picked', 'project', 'other'].map((name) => join(root, name));
    for (const folder of [picked, project, other]) await mkdir(folder);
    let broken = false;
    const base = await createFolderApprovals(join(root, 'approved-folders.json'));
    const folders = promised(
      withCheckoutFolders(base.folders, {
        has: (path) =>
          broken
            ? Effect.fail(new Error('The workspace is closed.'))
            : Effect.succeed(path === project),
      }),
    );
    await folders.approve(picked);
    assert.equal(await folders.has(picked), true);
    assert.equal(await folders.has(project), true);
    assert.equal(await folders.has(other), false);
    // The project grants no picker approval: it is not listed again and lapses with its checkout.
    assert.deepEqual(await folders.listRecent(), [picked]);
    assert.equal(await base.has(project), false);
    broken = true;
    assert.equal(await folders.has(project), false);
    assert.equal(await folders.has(picked), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
