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
import { Effect, Layer } from 'effect';
import { LocalHostService } from '@moonbase/contracts/services';
import { createFolderApprovals, createRootFolders, withCheckoutFolders } from '../src/folders.ts';
import { LocalHostLive, LocalPiControl } from '@moonbase/chat-runtime';

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

test('checkout folders widen what chats may use without becoming picker grants', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-folders-')));
  try {
    const [picked, project, other] = ['picked', 'project', 'other'].map((name) => join(root, name));
    for (const folder of [picked, project, other]) await mkdir(folder);
    let broken = false;
    const base = createFolderApprovals(join(root, 'approved-folders.json'));
    const folders = withCheckoutFolders(base, {
      has: async (path) => {
        if (broken) throw new Error('The workspace is closed.');
        return path === project;
      },
    });
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

test('chat worktree approvals never push picker folders out of the recent list', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-folders-')));
  try {
    const file = join(root, 'approved-folders.json');
    const folder = async (name: string) => {
      const path = join(root, name);
      await mkdir(path);
      return path;
    };
    const approvals = createFolderApprovals(file);
    const picked = [await folder('alpha'), await folder('beta')];
    for (const path of picked) await approvals.approve(path);
    const worktrees: string[] = [];
    for (let n = 0; n < 201; n++) {
      worktrees.push(await approvals.approve(await folder(`worktree-${n}`), { recent: false }));
      // A worktree chat in use stays approved however many follow it.
      if (n === 100) await approvals.touch(worktrees[0]!);
    }
    const restarted = createFolderApprovals(file);
    assert.deepEqual(await restarted.listRecent(), [...picked].reverse());
    for (const path of picked) assert.equal(await restarted.has(path), true);
    assert.equal(await restarted.has(worktrees[0]!), true);
    // Past their own limit, the least recently used worktree approvals lapse.
    assert.equal(await restarted.has(worktrees[1]!), false);
    assert.equal(await restarted.has(worktrees[2]!), true);
    assert.equal(await restarted.has(worktrees.at(-1)!), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a use after a restart leads folders saved with a later clock reading', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-folders-')));
  try {
    const file = join(root, 'approved-folders.json');
    const [alpha, beta] = ['alpha', 'beta'].map((name) => join(root, name));
    for (const folder of [alpha, beta]) await mkdir(folder);
    await createFolderApprovals(file).approve(alpha);
    // A saved use stamped ahead of this clock, as a use within the same millisecond is.
    const saved = JSON.parse(await readFile(file, 'utf8'));
    saved[0].at = new Date(Date.now() + 60_000).toISOString();
    await writeFile(file, JSON.stringify(saved), { mode: 0o600 });

    const restarted = createFolderApprovals(file);
    await restarted.approve(beta);
    assert.deepEqual(await restarted.listRecent(), [beta, alpha]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a host-mode daemon allows its roots and folders under them, and refuses escapes, replacements and roots holding its data', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-roots-')));
  try {
    const [root, other, outside] = ['root', 'other', 'outside'].map((name) => join(base, name));
    for (const folder of [root, other, outside]) await mkdir(folder);
    for (const name of ['beta', 'alpha', '.hidden']) await mkdir(join(root, name));
    await mkdir(join(root, 'alpha', 'deep'));
    await writeFile(join(root, 'file.txt'), '');
    // A link inside a root that leads out of it.
    await symlink(outside, join(root, 'escape'));

    // Each root must be an existing folder named by its real path; errors name no path.
    for (const roots of [[join(base, 'missing')], [join(root, 'escape')], [join(root, 'file.txt')]])
      await assert.rejects(createRootFolders(roots), (error: Error) => {
        assert.equal((error as { code?: string }).code, 'InvalidInput');
        assert(!error.message.includes(base));
        return true;
      });

    // No root holds or sits in the daemon's data or its credential key, even one not made yet.
    for (const reserved of [join(root, 'alpha'), join(root, 'keys', 'credential.key'), base])
      await assert.rejects(createRootFolders([root], { reserved: [reserved] }), {
        code: 'InvalidInput',
      });

    const folders = await createRootFolders([root, other], {
      reserved: [join(outside, 'data'), join(outside, 'credential.key')],
    });
    assert.equal(folders.refusal, 'folder-outside-roots');
    // A host's chats never become projects.
    const host = { hostId: 'roots-host', storeId: 'roots-store' };
    const marked: unknown[] = [];
    const service = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          return yield* LocalHostService;
        }),
        LocalHostLive({ host, folders, chatFolders: join(base, 'chats') }).pipe(
          Layer.provide(
            Layer.succeed(LocalPiControl, {
              setAdmissionsOpen() {},
              hasActiveWork: () => Effect.succeed(false),
              markFolderAsProject: (target) => Effect.sync(() => void marked.push(target)),
            }),
          ),
        ),
      ),
    );
    await assert.rejects(
      Effect.runPromise(
        service.markFolderAsProject({
          requestId: 'mark',
          target: { host, actorId: 'owner', conversationId: '1' },
        }),
      ),
      { code: 'Incompatible' },
    );
    assert.deepEqual(marked, []);
    for (const allowed of [root, other, join(root, 'alpha'), join(root, 'alpha', 'deep')])
      assert.equal(await folders.has(allowed), true, allowed);
    for (const refused of [
      outside,
      base,
      join(root, 'escape'),
      join(root, 'alpha', '..', '..', 'outside'),
      join(root, 'file.txt'),
      join(root, 'missing'),
      `${root}-sibling`,
    ])
      assert.equal(await folders.has(refused), false, refused);
    assert.equal(await folders.approve(join(root, 'alpha')), join(root, 'alpha'));
    await assert.rejects(folders.approve(join(root, 'escape')), {
      code: 'Unauthorized',
    });
    await assert.rejects(folders.approve(join(root, 'missing')), {
      code: 'InvalidInput',
    });
    assert.deepEqual(await folders.listRecent(), []);
    // Roots first, then each root's folders in order, without hidden folders, files or links.
    assert.deepEqual(await folders.listFolders!(), [
      root,
      other,
      join(root, 'alpha'),
      join(root, 'beta'),
    ]);

    // A root replaced by another folder, or by a link, approves nothing under it.
    await rename(root, `${root}-moved`);
    await mkdir(root);
    await mkdir(join(root, 'alpha'));
    assert.equal(await folders.has(root), false);
    assert.equal(await folders.has(join(root, 'alpha')), false);
    await rm(root, { recursive: true });
    await symlink(outside, root);
    assert.equal(await folders.has(root), false);
    assert.deepEqual(await folders.listFolders!(), [other]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
