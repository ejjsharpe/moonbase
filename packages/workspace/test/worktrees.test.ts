import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ManagedRuntime } from 'effect';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import { WorkspaceLive } from '../src/index.ts';
import { fixture, rejects } from './workspace-fixture.ts';

function repository() {
  const f = fixture();
  const git = (args: string[], cwd = f.root) =>
    execFileSync('/usr/bin/git', [
      '-C',
      cwd,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      ...args,
    ])
      .toString()
      .trim();
  writeFileSync(join(f.root, 'file.txt'), 'main');
  git(['add', '.']);
  git(['commit', '-qm', 'initial']);
  return { ...f, git };
}
const branches = (git: (args: string[]) => string) =>
  git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').sort();

test('worktrees of one repository share a project and report main or linked', async () => {
  const f = repository();
  try {
    const linkedRoot = join(f.base, 'linked');
    f.git(['worktree', 'add', '-q', '-b', 'linked', linkedRoot, 'main']);
    f.git(['worktree', 'add', '-q', '--detach', join(f.base, 'detached'), 'main']);
    f.git(['worktree', 'add', '-q', '-b', 'gone', join(f.base, 'gone'), 'main']);
    f.git(['worktree', 'lock', join(f.base, 'detached')]);
    rmSync(join(f.base, 'gone'), { recursive: true });
    const main = await f.client.command('openCheckout', { root: f.root });
    const linked = await f.client.command('openCheckout', { root: linkedRoot });
    assert.equal(main.worktree, 'main');
    assert.equal(linked.worktree, 'linked');
    assert.equal(linked.branch, 'linked');
    assert.equal(linked.projectId, main.projectId);
    assert.notEqual(linked.checkoutId, main.checkoutId);

    const head = f.git(['rev-parse', 'HEAD']);
    const expected = [
      { root: f.root, branch: 'main', main: true, locked: false, prunable: false },
      {
        root: join(f.base, 'detached'),
        branch: head.slice(0, 7) + ' (detached)',
        main: false,
        locked: true,
        prunable: false,
      },
      { root: join(f.base, 'gone'), branch: 'gone', main: false, locked: false, prunable: true },
      { root: linkedRoot, branch: 'linked', main: false, locked: false, prunable: false },
    ];
    // Any worktree of the project lists the same set: main first, then Git's order.
    for (const checkout of [main, linked])
      assert.deepEqual((await f.client.command('listWorktrees', { checkout })).worktrees, expected);
  } finally {
    await f.close();
  }
});

test('a plain folder is not a checkout and lists no worktrees', async () => {
  const f = fixture();
  try {
    const folder = join(f.base, 'folder');
    mkdirSync(folder);
    await assert.rejects(f.client.command('openCheckout', { root: folder }));
    const checkout = await f.client.command('openCheckout', { root: f.root });
    await assert.rejects(
      f.client.command('listWorktrees', { checkout: { ...checkout, root: folder } }),
      rejects('Unauthorized'),
    );
  } finally {
    await f.close();
  }
});

test('createWorktree branches from base into a new opened linked checkout', async () => {
  const f = repository();
  try {
    const main = await f.client.command('openCheckout', { root: f.root });
    writeFileSync(join(f.root, 'file.txt'), 'uncommitted');
    const location = join(f.base, 'feature');
    const created = await f.client.command('createWorktree', {
      checkout: main,
      base: 'main',
      branch: 'feature/one',
      location,
    });
    assert.deepEqual(
      { ...created, checkoutId: undefined },
      {
        hostId: main.hostId,
        checkoutId: undefined,
        projectId: main.projectId,
        root: location,
        branch: 'feature/one',
        worktree: 'linked',
      },
    );
    assert.equal(f.git(['rev-parse', 'feature/one']), f.git(['rev-parse', 'main']));
    // The new checkout is approved: its committed files read, and it reopens to the same target.
    const file = await f.client.command('readFile', { checkout: created, path: 'file.txt' });
    assert.equal(file.text, 'main');
    assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), 'uncommitted');
    assert.deepEqual(await f.client.command('openCheckout', { root: location }), created);
    assert.deepEqual(
      (await f.client.command('listWorktrees', { checkout: created })).worktrees.map((worktree) => [
        worktree.root,
        worktree.branch,
        worktree.main,
      ]),
      [
        [f.root, 'main', true],
        [location, 'feature/one', false],
      ],
    );
    // A linked worktree can itself be the base for another.
    const nested = await f.client.command('createWorktree', {
      checkout: created,
      base: 'feature/one',
      branch: 'feature/two',
      location: join(f.base, 'two'),
    });
    assert.equal(nested.projectId, main.projectId);
  } finally {
    await f.close();
  }
});

test('createWorktree refuses taken branches and locations, bad bases and names, leaving no residue', async () => {
  const f = repository();
  try {
    const checkout = await f.client.command('openCheckout', { root: f.root });
    f.git(['branch', 'taken']);
    const taken = join(f.base, 'taken');
    mkdirSync(taken);
    writeFileSync(join(taken, 'keep.txt'), 'user data');
    const before = branches(f.git);
    const create = (input: { base?: string; branch?: string; location?: string }) =>
      f.client.command('createWorktree', {
        checkout,
        base: 'main',
        branch: 'fresh',
        location: join(f.base, 'fresh'),
        ...input,
      });
    await assert.rejects(create({ branch: 'taken' }), rejects('Conflict'));
    await assert.rejects(create({ branch: 'main' }), rejects('Conflict'));
    await assert.rejects(create({ location: taken }), rejects('Conflict'));
    await assert.rejects(create({ location: f.root }), rejects('Conflict'));
    await assert.rejects(
      create({ location: join(f.base, 'missing/fresh') }),
      rejects('InvalidInput'),
    );
    await assert.rejects(create({ location: f.base + '/a/../fresh' }), rejects('InvalidInput'));
    await assert.rejects(create({ location: 'relative' }), rejects('InvalidInput'));
    await assert.rejects(
      create({ location: join(f.dataDirectory, 'fresh') }),
      rejects('InvalidInput'),
    );
    await assert.rejects(create({ base: 'nonexistent' }), rejects('InvalidInput'));
    await assert.rejects(create({ branch: 'bad..name' }), rejects('InvalidInput'));
    await assert.rejects(create({ branch: 'bad.lock' }), rejects('InvalidInput'));
    await assert.rejects(create({ branch: '@{-1}' }), rejects('InvalidInput'));
    await assert.rejects(create({ branch: '-b' }), rejects('InvalidInput'));
    assert.deepEqual(branches(f.git), before);
    assert.equal(readFileSync(join(taken, 'keep.txt'), 'utf8'), 'user data');
    assert.equal(existsSync(join(f.base, 'fresh')), false);
    assert.equal(
      (await f.client.command('listWorktrees', { checkout })).worktrees.length,
      1,
      'no worktree was registered',
    );
  } finally {
    await f.close();
  }
});

test('a failed creation removes the worktree and branch it added', async () => {
  const f = repository();
  try {
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const hook = join(f.root, '.git/hooks/post-checkout');
    writeFileSync(hook, '#!/bin/sh\necho hook refused >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const before = branches(f.git);
    const location = join(f.base, 'hooked');
    await assert.rejects(
      f.client.command('createWorktree', { checkout, base: 'main', branch: 'hooked', location }),
      (error) => rejects('Unavailable')(error) && /hook refused/.test((error as Error).message),
    );
    assert.equal(existsSync(location), false);
    assert.deepEqual(branches(f.git), before);
    assert.equal(f.git(['worktree', 'list', '--porcelain']).split('\n\n').length, 1);
    // The same request succeeds once the hook allows it: nothing stale blocks a retry.
    writeFileSync(hook, '#!/bin/sh\nexit 0\n');
    const created = await f.client.command('createWorktree', {
      checkout,
      base: 'main',
      branch: 'hooked',
      location,
    });
    assert.equal(created.worktree, 'linked');
  } finally {
    await f.close();
  }
});

test('cancelling creation removes what Git had added', async () => {
  const f = repository();
  try {
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const hook = join(f.root, '.git/hooks/post-checkout');
    const marker = join(f.base, 'hook-started');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexec sleep 1\n`);
    chmodSync(hook, 0o755);
    const before = branches(f.git);
    const location = join(f.base, 'cancelled');
    const abort = new AbortController();
    const pending = f.client.command(
      'createWorktree',
      { checkout, base: 'main', branch: 'cancelled', location },
      { signal: abort.signal },
    );
    while (!existsSync(marker)) await new Promise((resolve) => setTimeout(resolve, 10));
    abort.abort();
    await assert.rejects(pending, rejects('Cancelled'));
    // Cleanup continues after the caller is released; it never outlives the workspace scope.
    const deadline = Date.now() + 10_000;
    while ((existsSync(location) || branches(f.git).includes('cancelled')) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(existsSync(location), false);
    assert.deepEqual(branches(f.git), before);
  } finally {
    await f.close();
  }
});

test('cleanup keeps files a failed creation did not own', async () => {
  const f = repository();
  try {
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const hook = join(f.root, '.git/hooks/post-checkout');
    // The hook leaves an untracked file, so removal without force must refuse and report it.
    writeFileSync(hook, '#!/bin/sh\necho note > untracked.txt\nexit 1\n');
    chmodSync(hook, 0o755);
    const location = join(f.base, 'kept');
    await assert.rejects(
      f.client.command('createWorktree', { checkout, base: 'main', branch: 'kept', location }),
      (error) => rejects('Uncertain')(error) && (error as Error).message.includes(location),
    );
    assert.equal(readFileSync(join(location, 'untracked.txt'), 'utf8'), 'note\n');
    assert.ok(branches(f.git).includes('kept'), 'a checked-out branch is never deleted');
  } finally {
    await f.close();
  }
});

test('a bare repository has no main working tree to list', async () => {
  const f = repository();
  try {
    const bare = join(f.base, 'bare.git');
    execFileSync('/usr/bin/git', ['clone', '-q', '--bare', f.root, bare]);
    const linkedRoot = join(f.base, 'from-bare');
    f.git(['worktree', 'add', '-q', '-b', 'topic', linkedRoot, 'main'], bare);
    const linked = await f.client.command('openCheckout', { root: linkedRoot });
    assert.equal(linked.worktree, 'linked');
    assert.deepEqual((await f.client.command('listWorktrees', { checkout: linked })).worktrees, [
      { root: linkedRoot, branch: 'topic', main: false, locked: false, prunable: false },
    ]);
  } finally {
    await f.close();
  }
});

test("a removed worktree's location and branch name can be created again", async () => {
  const f = repository();
  try {
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const location = join(f.base, 'again');
    const create = () =>
      f.client.command('createWorktree', { checkout, base: 'main', branch: 'again', location });
    const first = await create();
    f.git(['worktree', 'remove', location]);
    f.git(['branch', '-D', 'again']);
    // The removed worktree's approval no longer names the directory now at its location.
    const second = await create();
    assert.notEqual(second.checkoutId, first.checkoutId);
    const file = await f.client.command('readFile', { checkout: second, path: 'file.txt' });
    assert.equal(file.text, 'main');
    assert.deepEqual(await f.client.command('openCheckout', { root: location }), second);
    await assert.rejects(f.client.command('readFile', { checkout: first, path: 'file.txt' }));
    // Only a creation supersedes an approval: a directory replaced by anything else is refused.
    f.git(['worktree', 'remove', location]);
    f.git(['worktree', 'add', '-q', '--detach', location, 'main']);
    await assert.rejects(
      f.client.command('openCheckout', { root: location }),
      rejects('InvalidInput'),
    );
    await assert.rejects(f.client.command('readFile', { checkout: second, path: 'file.txt' }));
  } finally {
    await f.close();
  }
});

test('cancelling during checkout stops Git and its children and removes the locked worktree', async () => {
  const f = repository();
  try {
    const checkout = await f.client.command('openCheckout', { root: f.root });
    // A slow smudge filter holds Git inside the checkout, while the new worktree is still locked.
    const started = join(f.base, 'smudge-started');
    writeFileSync(join(f.root, '.gitattributes'), '*.txt filter=slow\n');
    f.git(['add', '.']);
    f.git(['commit', '-qm', 'attributes']);
    f.git([
      'config',
      'filter.slow.smudge',
      `echo $$ > '${started}.tmp'; mv '${started}.tmp' '${started}'; sleep 30; cat`,
    ]);
    const before = branches(f.git);
    const location = join(f.base, 'checkout-cancelled');
    const abort = new AbortController();
    const pending = f.client.command(
      'createWorktree',
      { checkout, base: 'main', branch: 'checkout-cancelled', location },
      { signal: abort.signal },
    );
    while (!existsSync(started)) await new Promise((resolve) => setTimeout(resolve, 10));
    const filter = Number(readFileSync(started, 'utf8'));
    assert.match(f.git(['worktree', 'list', '--porcelain']), /\nlocked/, 'checkout under way');
    const cancelledAt = Date.now();
    abort.abort();
    await assert.rejects(pending, rejects('Cancelled'));
    const deadline = Date.now() + 10_000;
    while (
      (existsSync(location) || branches(f.git).includes('checkout-cancelled')) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert(Date.now() - cancelledAt < 10_000, 'the filter was not left to finish');
    assert.equal(existsSync(location), false);
    assert.deepEqual(branches(f.git), before);
    assert.equal(f.git(['worktree', 'list', '--porcelain']).split('\n\n').length, 1);
    assert.throws(() => process.kill(filter, 0), { code: 'ESRCH' });
  } finally {
    await f.close();
  }
});

/** A workspace whose Git runs `afterAdd` (sh, with `$location`) after a real `worktree add`. */
function withGit(f: ReturnType<typeof repository>, afterAdd: string) {
  const git = join(f.base, 'wrapped-git');
  writeFileSync(
    git,
    [
      '#!/bin/sh',
      'last=; location=',
      'for arg; do location=$last; last=$arg; done',
      '/usr/bin/git "$@" || exit $?',
      'case " $* " in',
      `  *" worktree add "*) ${afterAdd} ;;`,
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(git, 0o755);
  const runtime = ManagedRuntime.make(
    WorkspaceLive({
      dataDirectory: join(f.base, 'wrapped-state'),
      hostId: 'local-test',
      gitExecutable: git,
    }),
  );
  return { runtime, client: makeEditorClient(runtime) };
}
const registered = (f: ReturnType<typeof repository>) =>
  f.git(['worktree', 'list', '--porcelain']).split('\n\n').length;

test('cleanup removes a worktree Git left locked mid-creation, and its branch', async () => {
  const f = repository();
  // Git leaves the new worktree locked, as an interrupted checkout does.
  const { runtime, client } = withGit(
    f,
    '/usr/bin/git worktree lock --reason initializing "$location"; echo checkout interrupted >&2; exit 1',
  );
  try {
    const checkout = await client.command('openCheckout', { root: f.root });
    const before = branches(f.git);
    const location = join(f.base, 'interrupted');
    await assert.rejects(
      client.command('createWorktree', { checkout, base: 'main', branch: 'interrupted', location }),
      (error) =>
        rejects('Unavailable')(error) && /checkout interrupted/.test((error as Error).message),
    );
    assert.equal(existsSync(location), false);
    assert.deepEqual(branches(f.git), before);
    assert.equal(registered(f), 1);
  } finally {
    await runtime.dispose();
    await f.close();
  }
});

test('cleanup never forces a worktree locked for any other reason', async () => {
  const f = repository();
  const { runtime, client } = withGit(
    f,
    '/usr/bin/git worktree lock --reason "on a portable drive" "$location"; echo failed >&2; exit 1',
  );
  try {
    const checkout = await client.command('openCheckout', { root: f.root });
    const location = join(f.base, 'user-locked');
    await assert.rejects(
      client.command('createWorktree', { checkout, base: 'main', branch: 'user-locked', location }),
      (error) => rejects('Uncertain')(error) && (error as Error).message.includes(location),
    );
    assert.equal(readFileSync(join(location, 'file.txt'), 'utf8'), 'main');
    assert.equal(registered(f), 2);
    assert.ok(branches(f.git).includes('user-locked'), 'a branch still checked out is kept');
  } finally {
    await runtime.dispose();
    await f.close();
  }
});

test('a new worktree is approved only at the location it was made, else kept for inspection', async () => {
  const f = repository();
  // The location is swapped for a link to another folder between creation and approval.
  const { runtime, client } = withGit(
    f,
    'mv "$location" "$location-moved"; ln -s "$location-moved" "$location"',
  );
  try {
    const checkout = await client.command('openCheckout', { root: f.root });
    const location = join(f.base, 'swapped');
    await assert.rejects(
      client.command('createWorktree', { checkout, base: 'main', branch: 'swapped', location }),
      (error) => rejects('Uncertain')(error) && /location changed/.test((error as Error).message),
    );
    assert.ok(branches(f.git).includes('swapped'), 'a branch still checked out is kept');
    assert.equal(readFileSync(join(location + '-moved', 'file.txt'), 'utf8'), 'main');
  } finally {
    await runtime.dispose();
    await f.close();
  }
});

test("a location registered to a missing worktree is refused and the user's registration kept", async () => {
  const f = repository();
  try {
    const checkout = await f.client.command('openCheckout', { root: f.root });
    for (const locked of [true, false]) {
      const name = locked ? 'portable' : 'moved';
      const location = join(f.base, name);
      f.git(['worktree', 'add', '-q', '-b', name, location, 'main']);
      if (locked) f.git(['worktree', 'lock', '--reason', 'on a portable drive', location]);
      // Its folder is gone for now (moved, or on an unmounted drive); Git still registers it.
      renameSync(location, location + '-away');
      const admin = join(f.root, '.git/worktrees', name);
      const before = branches(f.git);
      await assert.rejects(
        f.client.command('createWorktree', {
          checkout,
          base: 'main',
          branch: `chat/${name}`,
          location,
        }),
        rejects('Conflict'),
      );
      assert.deepEqual(branches(f.git), before, 'no branch was created');
      assert.equal(existsSync(join(admin, 'HEAD')), true);
      assert.equal(existsSync(join(admin, 'locked')), locked);
    }
  } finally {
    await f.close();
  }
});

test('concurrent creations at one location never remove each other', async () => {
  const f = repository();
  try {
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const location = join(f.base, 'shared');
    const results = await Promise.allSettled(
      ['first', 'second'].map((branch) =>
        f.client.command('createWorktree', { checkout, base: 'main', branch, location }),
      ),
    );
    const created = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    const refused = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    assert.equal(created.length, 1);
    assert.ok(rejects('Conflict')(refused[0]));
    const file = await f.client.command('readFile', { checkout: created[0]!, path: 'file.txt' });
    assert.equal(file.text, 'main');
    assert.equal(registered(f), 2);
  } finally {
    await f.close();
  }
});
