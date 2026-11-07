import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFolderApprovals } from '../src/chat/folders.ts';

test('native folder approvals survive a restart and lapse when the folder is replaced', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-folders-')));
  try {
    const file = join(root, 'approved-folders.json');
    const [alpha, beta, worktree] = ['alpha', 'beta', 'worktree'].map((name) => join(root, name));
    for (const folder of [alpha, beta, worktree]) await mkdir(folder);
    await symlink(beta, join(root, 'link'));

    const first = createFolderApprovals(file);
    assert.equal(await first.approve(alpha), alpha);
    // The picker's answer is resolved, so a link approves the folder it names.
    assert.equal(await first.approve(join(root, 'link')), beta);
    assert.equal(await first.approve(worktree, { recent: false }), worktree);
    await assert.rejects(first.approve(file + '-missing'));
    assert.equal(await first.has(join(root, 'link')), false);

    const restarted = createFolderApprovals(file);
    assert.equal(await restarted.has(alpha), true);
    assert.equal(await restarted.has(worktree), true);
    assert.deepEqual(await restarted.listRecent(), [beta, alpha]);
    await restarted.touch(alpha);
    assert.deepEqual(await restarted.listRecent(), [alpha, beta]);

    // A different directory at the same path is not the folder that was approved.
    await rename(alpha, join(root, 'moved'));
    await mkdir(alpha);
    assert.equal(await restarted.has(alpha), false);
    assert.deepEqual(await createFolderApprovals(file).listRecent(), [beta]);
    await rm(beta, { recursive: true });
    assert.deepEqual(await createFolderApprovals(file).listRecent(), []);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unreadable approvals file approves nothing and is replaced on the next approval', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-folders-')));
  try {
    const file = join(root, 'approved-folders.json');
    await writeFile(file, '{not json', { mode: 0o600 });
    const folder = join(root, 'project');
    await mkdir(folder);
    const approvals = createFolderApprovals(file);
    assert.equal(await approvals.has(folder), false);
    assert.deepEqual(await approvals.listRecent(), []);
    await approvals.approve(folder);
    assert.deepEqual(await createFolderApprovals(file).listRecent(), [folder]);

    // A list others can write is not trusted.
    await writeFile(
      file,
      JSON.stringify([{ path: folder, dev: 0, ino: 0, at: '', recent: true }]),
      {
        mode: 0o666,
      },
    );
    assert.deepEqual(await createFolderApprovals(file).listRecent(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
