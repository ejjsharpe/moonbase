import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Effect, ManagedRuntime } from 'effect';
import { WorkspaceHostService } from '@moonbase/contracts/services';
import type { ChatTarget } from '@moonbase/contracts/chat';
import { ApplicationError } from '@moonbase/contracts/workspace';
import {
  WorkspaceFolders,
  WorkspaceHostLive,
  type ChatFolders,
  type RootPredicate,
} from '../src/index.ts';

const chat: ChatTarget = {
  host: { hostId: 'chat-folders-host', storeId: 'store' },
  actorId: 'actor',
  conversationId: 'chat-1',
};

function setup(
  options: {
    allowRoot?: RootPredicate;
    chats?: ChatFolders;
    nativeImports?: boolean;
  } = {},
) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moonbase-chat-folders-')));
  const runtime = ManagedRuntime.make(
    WorkspaceHostLive({
      dataDirectory: join(base, 'state'),
      hostId: 'chat-folders-host',
      ...options,
    }),
  );
  const git = (root: string, ...args: string[]) =>
    execFileSync('/usr/bin/git', [
      '-C',
      root,
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@e.invalid',
      ...args,
    ])
      .toString()
      .trim();
  return {
    base,
    git,
    /** A repository with one commit, or none when `commit` is false. */
    repository(name: string, commit = true) {
      const root = join(base, ...name.split('/'));
      mkdirSync(root, { recursive: true });
      git(root, 'init', '-q', '-b', 'main');
      if (commit) {
        writeFileSync(join(root, 'file.txt'), 'x');
        git(root, 'add', '.');
        git(root, 'commit', '-qm', 'initial');
      }
      return root;
    },
    host: () => runtime.runPromise(WorkspaceHostService),
    folders: () => runtime.runPromise(WorkspaceFolders),
    async close() {
      await runtime.dispose();
      rmSync(base, { recursive: true, force: true });
    },
  };
}
const run = <A>(effect: Effect.Effect<A, ApplicationError>) => Effect.runPromise(effect);
const code = async <A>(effect: Effect.Effect<A, ApplicationError>) =>
  (await Effect.runPromise(Effect.flip(effect))).code;
const request = (requestId: string, root: string, branch: string) => ({
  installationId: 'alice',
  requestId,
  root,
  branch,
});

test('a chat worktree is made beside the repository, numbered when taken, and its request replays', async () => {
  const f = setup();
  try {
    const host = await f.host(),
      root = f.repository('repo');
    const first = await run(host.createChatWorktree(request('one', root, 'chat/topic')));
    assert.equal(first.root, join(f.base, 'repo-worktrees', 'chat-topic'));
    assert.equal(first.vcs === 'git' && first.branch, 'chat/topic');
    assert.equal(first.vcs === 'git' && first.worktree, 'linked');
    // The returned checkout is approved: nothing else needs opening.
    await run(host.verifyCheckout({ checkout: first }));
    const taken = await run(host.createChatWorktree(request('two', root, 'chat/topic')));
    assert.equal(taken.root, join(f.base, 'repo-worktrees', 'chat-topic-2'));
    // A repeat of a request returns its worktree and makes no other.
    assert.deepEqual(await run(host.createChatWorktree(request('one', root, 'chat/topic'))), first);
    assert.deepEqual(readdirSync(join(f.base, 'repo-worktrees')).sort(), [
      'chat-topic',
      'chat-topic-2',
    ]);
    // The same ID with another branch is a different payload.
    assert.equal(await code(host.createChatWorktree(request('one', root, 'other'))), 'Conflict');
    // A chat made from a worktree is placed beside the main one, not the worktree.
    const nested = await run(host.createChatWorktree(request('three', first.root, 'again')));
    assert.equal(nested.root, join(f.base, 'repo-worktrees', 'again'));
  } finally {
    await f.close();
  }
});

test('a branch named like a folder of the name falls back to a flat one; branches inside the name number it; other Git failures stay failures', async () => {
  const f = setup();
  try {
    const host = await f.host(),
      root = f.repository('repo');
    f.git(root, 'branch', 'chat');
    const flat = await run(host.createChatWorktree(request('one', root, 'chat/topic')));
    assert.equal(flat.vcs === 'git' && flat.branch, 'chat-topic');
    assert.equal(flat.root, join(f.base, 'repo-worktrees', 'chat-topic'));
    f.git(root, 'branch', 'nest/inner');
    const numbered = await run(host.createChatWorktree(request('two', root, 'nest')));
    assert.equal(numbered.vcs === 'git' && numbered.branch, 'nest-2');
    // A hook that fails for a nested branch is that creation's failure, not a flat retry.
    const hook = join(root, '.git', 'hooks', 'post-checkout');
    writeFileSync(
      hook,
      '#!/bin/sh\ncase "$(git symbolic-ref --short HEAD)" in */*) exit 1;; esac\n',
    );
    chmodSync(hook, 0o755);
    assert.equal(
      await code(host.createChatWorktree(request('three', root, 'feature/x'))),
      'Unavailable',
    );
    assert.equal(existsSync(join(f.base, 'repo-worktrees', 'feature-x')), false);
    assert.equal(f.git(root, 'branch', '--list', 'feature*'), '');
    // A repository with no commit has nothing to branch from.
    const empty = f.repository('empty', false);
    assert.equal(await code(host.createChatWorktree(request('four', empty, 'x'))), 'InvalidInput');
    assert.equal(await code(host.createChatWorktree(request('bad', root, 'a..b'))), 'InvalidInput');
  } finally {
    await f.close();
  }
});

test('a host that opens only some roots makes chat worktrees only where their parent folder is allowed', async () => {
  let base = '';
  const f = setup({
    allowRoot: (real) =>
      [join(base, 'solo'), join(base, 'roots')].includes(real) ||
      real.startsWith(join(base, 'roots/')),
  });
  base = f.base;
  try {
    const host = await f.host();
    const inside = f.repository('roots/repo');
    const made = await run(host.createChatWorktree(request('one', inside, 'work')));
    assert.equal(made.root, join(f.base, 'roots', 'repo-worktrees', 'work'));
    // A repository that is itself the root has its `-worktrees` folder outside it.
    const solo = f.repository('solo');
    assert.equal(await code(host.createChatWorktree(request('two', solo, 'work'))), 'Unauthorized');
    assert.equal(existsSync(join(f.base, 'solo-worktrees')), false);
    const outside = f.repository('elsewhere');
    assert.equal(
      await code(host.createChatWorktree(request('three', outside, 'w'))),
      'Unauthorized',
    );
    assert.equal(existsSync(join(f.base, 'elsewhere-worktrees')), false);
  } finally {
    await f.close();
  }
});

test('turning a chat into a project opens its own folder once, and leaves the chat alone when that fails', async () => {
  const marked: string[] = [];
  let folder = '';
  let failMark = false;
  const f = setup({
    chats: {
      findOwnFolder: async () => {
        if (!folder)
          throw new ApplicationError({
            code: 'Unauthorized',
            message: 'Not a chat folder.',
          });
        return folder;
      },
      markAsProject: async (requestId) => {
        if (failMark) throw new ApplicationError({ code: 'Unavailable', message: 'Down.' });
        marked.push(requestId);
      },
    },
  });
  try {
    const host = await f.host();
    const input = (requestId: string) => ({
      installationId: 'alice',
      requestId,
      target: chat,
    });
    // A folder the daemon didn't make is refused before anything opens or is marked.
    assert.equal(await code(host.turnChatIntoProject(input('refused'))), 'Unauthorized');
    folder = f.repository('chats/one');
    failMark = true;
    assert.equal(await code(host.turnChatIntoProject(input('down'))), 'Unavailable');
    assert.deepEqual(marked, []);
    failMark = false;
    const target = await run(host.turnChatIntoProject(input('first')));
    assert.equal(target.root, folder);
    assert.deepEqual(await run(host.turnChatIntoProject(input('first'))), target);
    assert.deepEqual(marked, ['first']);
    // The folder became a link target since: the open lands elsewhere and nothing is marked.
    const real = f.repository('chats/two');
    symlinkSync(real, join(f.base, 'chats', 'link'));
    folder = join(f.base, 'chats', 'link');
    assert.equal(await code(host.turnChatIntoProject(input('linked'))), 'Unauthorized');
    assert.deepEqual(marked, ['first']);
  } finally {
    await f.close();
  }
});

test('a host without chats cannot turn one into a project', async () => {
  const f = setup();
  try {
    const host = await f.host();
    assert.equal(
      await code(
        host.turnChatIntoProject({
          installationId: 'alice',
          requestId: 'r',
          target: chat,
        }),
      ),
      'Incompatible',
    );
  } finally {
    await f.close();
  }
});

test('a folder is the root of an approved checkout, checked again on every use', async () => {
  let allowed = true;
  const f = setup({ allowRoot: () => allowed });
  try {
    const host = await f.host(),
      folders = await f.folders();
    const has = (path: string) => run(folders.has(path));
    const root = f.repository('repo');
    const linked = join(f.base, 'linked');
    f.git(root, 'worktree', 'add', '-q', '-b', 'linked', linked);
    assert.equal(await has(root), false);
    const checkout = await run(host.openCheckout({ root }));
    assert.equal(await has(root), true);
    // A worktree is a folder only once it is opened itself.
    assert.equal(await has(linked), false);
    await run(host.openCheckout({ root: linked }));
    // A folder check borrows a descriptor: it is not kept against the retained cap.
    const open = readdirSync('/dev/fd').length;
    assert.equal(await has(linked), true);
    assert.equal(readdirSync('/dev/fd').length, open);
    assert.equal(await has(join(root, '.git')), false);
    symlinkSync(root, join(f.base, 'link'));
    assert.equal(await has(join(f.base, 'link')), false);
    // A worktree folder replaced by another directory is not that worktree.
    renameSync(linked, join(f.base, 'moved'));
    mkdirSync(linked);
    assert.equal(await has(linked), false);
    renameSync(root, join(f.base, 'old'));
    mkdirSync(root);
    assert.equal(await has(root), false);
    assert.ok(await code(host.verifyCheckout({ checkout })));
    // A plain folder checkout is a folder while the host's root policy allows it.
    const plain = join(f.base, 'plain');
    mkdirSync(plain);
    await run(host.openCheckout({ root: plain }));
    assert.equal(await has(plain), true);
    allowed = false;
    assert.equal(await has(plain), false);
  } finally {
    await f.close();
  }
});

test('a host that takes no native imports refuses to hold or release them', async () => {
  const f = setup({ nativeImports: false });
  try {
    const host = await f.host(),
      plain = join(f.base, 'plain'),
      source = join(f.base, 'source.txt');
    mkdirSync(plain);
    writeFileSync(source, 'x');
    const checkout = await run(host.openCheckout({ root: plain }));
    assert.equal(
      await code(host.captureImports({ checkout, clientId: 'c', paths: [source] })),
      'Incompatible',
    );
    assert.equal(
      await code(host.releaseImports({ checkout, clientId: 'c', references: ['x'] })),
      'Incompatible',
    );
  } finally {
    await f.close();
  }
});
