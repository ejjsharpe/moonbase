import assert from 'node:assert/strict';
import { mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Effect, Layer } from 'effect';
import { LocalHostService } from '@moonbase/contracts/services';
import { LocalHostLive, LocalPiControl } from '@moonbase/chat-runtime';
import { createRootFolders, temporaryFolder } from './folders-fixture.ts';

test('a host-mode daemon allows its roots and folders under them, and refuses escapes, replacements and roots holding its data', async () => {
  const base = await temporaryFolder('moonbase-roots-');
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
        assert.equal((error as { problem?: string }).problem, 'not-real-folder');
        assert(!error.message.includes(base));
        return true;
      });

    // No root holds or sits in the daemon's data or its credential key, even one not made yet.
    // A reserved path spelled in another case is the same place on a case-insensitive volume.
    for (const reserved of [
      join(root, 'alpha'),
      join(root, 'keys', 'credential.key'),
      join(root.toUpperCase(), 'missing', 'token'),
      base,
    ])
      await assert.rejects(createRootFolders([root], { reserved: [reserved] }), {
        _tag: 'InvalidRootsError',
        problem: 'holds-reserved',
      });

    const folders = await createRootFolders([root, other], {
      reserved: [join(outside, 'data'), join(outside, 'credential.key')],
    });
    assert.equal(folders.refusal, 'outside-roots');
    // A host's chats never become projects.
    const host = { hostId: 'roots-host', storeId: 'roots-store' };
    const marked: unknown[] = [];
    const service = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          return yield* LocalHostService;
        }),
        LocalHostLive({ host, folders: folders.folders, chatFolders: join(base, 'chats') }).pipe(
          Layer.provide(
            Layer.succeed(LocalPiControl, {
              setAdmissionsOpen: () => Effect.void,
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
      { _tag: 'IncompatibleHostError', reason: 'host-chat-projects' },
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
      _tag: 'FolderRefusedError',
      refusal: 'outside-roots',
    });
    await assert.rejects(folders.approve(join(root, 'missing')), { _tag: 'FolderMissingError' });
    assert.deepEqual(await folders.listRecent(), []);
    // Roots first, then each root's folders in order, without hidden folders, files or links.
    assert.deepEqual(await folders.listFolders(), [
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
    assert.deepEqual(await folders.listFolders(), [other]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
