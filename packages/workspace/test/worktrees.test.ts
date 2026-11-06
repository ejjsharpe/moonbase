import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
