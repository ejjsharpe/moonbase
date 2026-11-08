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

test("cleanup removes what a failed creation's own hook wrote, and a success stays unlocked", async () => {
  const f = repository();
  try {
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const hook = join(f.root, '.git/hooks/post-checkout');
    const locale = join(f.base, 'hook-locale');
    // The worktree still holds this creation's lock, so the untracked file its hook left goes
    // with it. Hooks run in the user's locale.
    writeFileSync(
      hook,
      `#!/bin/sh\necho "\${LC_ALL-unset}" > '${locale}'\necho note > untracked.txt\nexit 1\n`,
    );
    chmodSync(hook, 0o755);
    const location = join(f.base, 'hooked-files');
    await assert.rejects(
      f.client.command('createWorktree', { checkout, base: 'main', branch: 'hooked', location }),
      rejects('Unavailable'),
    );
    assert.equal(existsSync(location), false);
    assert.equal(branches(f.git).includes('hooked'), false);
    assert.equal(readFileSync(locale, 'utf8').trim(), process.env.LC_ALL ?? 'unset');
    writeFileSync(hook, '#!/bin/sh\nexit 0\n');
    const created = await f.client.command('createWorktree', {
      checkout,
      base: 'main',
      branch: 'hooked',
      location,
    });
    const listed = await f.client.command('listWorktrees', { checkout: created });
    assert.equal(listed.worktrees.find((worktree) => worktree.root === location)?.locked, false);
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
function withGit(
  f: ReturnType<typeof repository>,
  afterAdd: string,
  create: { before?: string; after?: string; unlock?: string } = {},
) {
  const git = join(f.base, 'wrapped-git');
  writeFileSync(
    git,
    [
      '#!/bin/sh',
      'last=; location=',
      'for arg; do location=$last; last=$arg; done',
      'case " $* " in',
      `  *" update-ref --create-reflog "*) ${create.before ?? ':'} ;;`,
      `  *" worktree unlock "*) ${create.unlock ?? ':'} ;;`,
      'esac',
      '/usr/bin/git "$@" || exit $?',
      'case " $* " in',
      `  *" worktree add "*) ${afterAdd} ;;`,
      `  *" update-ref --create-reflog "*) ${create.after ?? ':'} ;;`,
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
const waitFor = async (path: string) => {
  while (!existsSync(path)) await new Promise((resolve) => setTimeout(resolve, 10));
};
const registered = (f: ReturnType<typeof repository>) =>
  f.git(['worktree', 'list', '--porcelain']).split('\n\n').length;

test('cleanup removes a worktree this creation still has locked, and its branch', async () => {
  const f = repository();
  // Git fails after adding the worktree, as an interrupted checkout does.
  const { runtime, client } = withGit(f, 'echo checkout interrupted >&2; exit 1');
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
    '/usr/bin/git worktree unlock "$location"; /usr/bin/git worktree lock --reason "on a portable drive" "$location"; echo failed >&2; exit 1',
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

test('cleanup leaves a worktree another tool added at the location meanwhile', async () => {
  const f = repository();
  writeFileSync(join(f.root, '.gitignore'), '.env\n');
  f.git(['add', '.']);
  f.git(['commit', '-qm', 'ignore']);
  const location = join(f.base, 'shared');
  // Just before the branch is made, a terminal adds its own worktree there with an ignored secret.
  const { runtime, client } = withGit(f, ':', {
    before: `/usr/bin/git worktree add -q -b users-branch '${location}' main >/dev/null 2>&1; echo SECRET > '${location}/.env'`,
  });
  try {
    const checkout = await client.command('openCheckout', { root: f.root });
    await assert.rejects(
      client.command('createWorktree', { checkout, base: 'main', branch: 'chat-x', location }),
      (error) => rejects('Uncertain')(error) && /another worktree/.test((error as Error).message),
    );
    assert.equal(readFileSync(join(location, '.env'), 'utf8'), 'SECRET\n');
    assert.equal(registered(f), 2);
    assert.ok(branches(f.git).includes('users-branch'));
  } finally {
    await runtime.dispose();
    await f.close();
  }
});

test("cancelling around the branch's creation deletes only a branch this creation made", async () => {
  for (const ours of [false, true]) {
    const f = repository();
    const marker = join(f.base, 'branch-step');
    // Either someone else makes the branch first, so the create-only update fails, or the
    // update succeeds; either way the request is cancelled before Git reports back.
    const { runtime, client } = withGit(
      f,
      ':',
      ours
        ? { after: `touch '${marker}'; sleep 5` }
        : { before: `/usr/bin/git branch chat-x main; touch '${marker}'; sleep 5` },
    );
    try {
      const checkout = await client.command('openCheckout', { root: f.root });
      const abort = new AbortController();
      const pending = client.command(
        'createWorktree',
        { checkout, base: 'main', branch: 'chat-x', location: join(f.base, 'chat-x') },
        { signal: abort.signal },
      );
      await waitFor(marker);
      abort.abort();
      await assert.rejects(pending, rejects('Cancelled'));
      // Cleanup outlives the released caller but never the workspace.
      await runtime.dispose();
      assert.equal(
        branches(f.git).includes('chat-x'),
        !ours,
        ours ? 'ours removed' : 'theirs kept',
      );
      assert.equal(existsSync(join(f.base, 'chat-x')), false);
    } finally {
      await runtime.dispose();
      await f.close();
    }
  }
});

test('a new worktree that resolves into another repository is not approved', async () => {
  const f = repository();
  const other = join(f.base, 'other');
  mkdirSync(other);
  f.git(['init', '-q', '-b', 'main'], other);
  writeFileSync(join(other, 'other.txt'), 'other');
  f.git(['add', '.'], other);
  f.git(['commit', '-qm', 'other'], other);
  // Between creation and approval the location becomes another repository's worktree.
  const { runtime, client } = withGit(
    f,
    `/usr/bin/git worktree remove --force --force "$location" &&/usr/bin/git -C '${other}' worktree add -q --detach "$location"`,
  );
  try {
    const checkout = await client.command('openCheckout', { root: f.root });
    const location = join(f.base, 'elsewhere');
    await assert.rejects(
      client.command('createWorktree', { checkout, base: 'main', branch: 'elsewhere', location }),
      (error) => rejects('Uncertain')(error) && /another repository/.test((error as Error).message),
    );
    assert.equal(readFileSync(join(location, 'other.txt'), 'utf8'), 'other');
  } finally {
    await runtime.dispose();
    await f.close();
  }
});

test('a creation cancelled while queued behind another ends at once and adds nothing', async () => {
  const f = repository();
  try {
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const hook = join(f.root, '.git/hooks/post-checkout');
    const marker = join(f.base, 'first-checkout');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nsleep 2\n`);
    chmodSync(hook, 0o755);
    let firstDone = false;
    const first = f.client
      .command('createWorktree', {
        checkout,
        base: 'main',
        branch: 'first',
        location: join(f.base, 'first'),
      })
      .finally(() => {
        firstDone = true;
      });
    await waitFor(marker);
    const abort = new AbortController();
    const queued = f.client.command(
      'createWorktree',
      { checkout, base: 'main', branch: 'queued', location: join(f.base, 'queued') },
      { signal: abort.signal },
    );
    abort.abort();
    await assert.rejects(queued, rejects('Cancelled'));
    assert.equal(firstDone, false, 'the queued creation did not wait for the running one');
    assert.equal((await first).worktree, 'linked');
    assert.equal(branches(f.git).includes('queued'), false);
    assert.equal(existsSync(join(f.base, 'queued')), false);
  } finally {
    await f.close();
  }
});

test('a registered location differing only in case is refused as taken', async () => {
  const f = repository();
  try {
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const users = join(f.base, 'Chat-X');
    f.git(['worktree', 'add', '-q', '-b', 'users', users, 'main']);
    renameSync(users, users + '-away');
    await assert.rejects(
      f.client.command('createWorktree', {
        checkout,
        base: 'main',
        branch: 'chat-x',
        location: join(f.base, 'chat-x'),
      }),
      rejects('Conflict'),
    );
    assert.equal(branches(f.git).includes('chat-x'), false);
    assert.equal(existsSync(join(f.root, '.git/worktrees/Chat-X/HEAD')), true);
  } finally {
    await f.close();
  }
});

test('cleanup leaves a worktree someone else added on this creation’s branch after it failed', async () => {
  const f = repository();
  // Ours goes, then a terminal adds its own worktree there on the same branch (as `git worktree
  // add <path>` does for a branch named after the folder) and starts working in it.
  const { runtime, client } = withGit(
    f,
    '/usr/bin/git worktree remove --force --force "$location" && /usr/bin/git worktree add -q "$location" "$last" && echo mine > "$location/notes.txt"; exit 1',
  );
  try {
    const checkout = await client.command('openCheckout', { root: f.root });
    const location = join(f.base, 'taken-over');
    await assert.rejects(
      client.command('createWorktree', { checkout, base: 'main', branch: 'taken-over', location }),
      (error) => rejects('Uncertain')(error) && /another worktree/.test((error as Error).message),
    );
    assert.equal(readFileSync(join(location, 'notes.txt'), 'utf8'), 'mine\n');
    assert.equal(registered(f), 2);
    assert.ok(branches(f.git).includes('taken-over'));
  } finally {
    await runtime.dispose();
    await f.close();
  }
});

test('cleanup keeps a branch that moved or became a symbolic ref', async () => {
  for (const change of ['moved', 'symbolic'] as const) {
    const f = repository();
    f.git(['branch', 'userbr']);
    f.git(['commit', '-q', '--allow-empty', '-m', 'later']);
    const later = f.git(['rev-parse', 'HEAD']);
    f.git(['reset', '-q', '--hard', 'HEAD~1']);
    const { runtime, client } = withGit(
      f,
      `/usr/bin/git worktree remove --force --force "$location"; ${
        change === 'moved'
          ? `/usr/bin/git update-ref "refs/heads/$last" ${later}`
          : '/usr/bin/git symbolic-ref "refs/heads/$last" refs/heads/userbr'
      }; exit 1`,
    );
    try {
      const checkout = await client.command('openCheckout', { root: f.root });
      await assert.rejects(
        client.command('createWorktree', {
          checkout,
          base: 'main',
          branch: change,
          location: join(f.base, change),
        }),
        (error) =>
          rejects('Uncertain')(error) &&
          (change === 'moved' ? /moved/ : /symbolic/).test((error as Error).message),
      );
      assert.ok(branches(f.git).includes('userbr'), 'the branch a symbolic ref names is kept');
      assert.ok(branches(f.git).includes(change));
    } finally {
      await runtime.dispose();
      await f.close();
    }
  }
});

test('a branch step that dies without a cancel (as at the time limit) is still cleaned up', async () => {
  const f = repository();
  // The branch is made, then Git dies by a signal before reporting back.
  const { runtime, client } = withGit(f, ':', { after: 'kill -TERM $$' });
  try {
    const checkout = await client.command('openCheckout', { root: f.root });
    await assert.rejects(
      client.command('createWorktree', {
        checkout,
        base: 'main',
        branch: 'killed',
        location: join(f.base, 'killed'),
      }),
      rejects('Unavailable'),
    );
    assert.equal(branches(f.git).includes('killed'), false);
  } finally {
    await runtime.dispose();
    await f.close();
  }
});

test('a decomposed (NFD) folder name is created and approved as Git names it', async () => {
  const f = repository();
  try {
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const created = await f.client.command('createWorktree', {
      checkout,
      base: 'main',
      branch: 'cafe',
      location: join(f.base, 'café'),
    });
    assert.equal(created.root, join(f.base, 'café'));
    const file = await f.client.command('readFile', { checkout: created, path: 'file.txt' });
    assert.equal(file.text, 'main');
  } finally {
    await f.close();
  }
});

test('a lock that will not release is reported without undoing the created worktree', async () => {
  const f = repository();
  const { runtime, client } = withGit(f, ':', { unlock: 'echo unlock refused >&2; exit 1' });
  let disposed = false;
  try {
    const checkout = await client.command('openCheckout', { root: f.root });
    const location = join(f.base, 'still-locked');
    const created = await client.command('createWorktree', {
      checkout,
      base: 'main',
      branch: 'still-locked',
      location,
    });
    const file = await client.command('readFile', { checkout: created, path: 'file.txt' });
    assert.equal(file.text, 'main');
    disposed = true;
    await assert.rejects(runtime.dispose(), /still locked.*unlock refused/s);
  } finally {
    if (!disposed) await runtime.dispose();
    await f.close();
  }
});
