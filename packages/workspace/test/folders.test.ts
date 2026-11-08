import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { fixture, rejects } from './workspace-fixture.ts';

/** A plain folder beside the fixture's repository, in no repository itself. */
function folder(f: ReturnType<typeof fixture>) {
  const root = join(f.base, 'notes');
  mkdirSync(join(root, 'drafts'), { recursive: true });
  writeFileSync(join(root, 'todo.txt'), 'plan');
  return root;
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync('/usr/bin/git', ['-C', cwd, ...args])
    .toString()
    .trim();

test('a plain folder opens without Git; Git reads are empty and Git changes are refused', async () => {
  const f = fixture();
  let stop: (() => Promise<void>) | undefined;
  try {
    const root = folder(f);
    const checkout = await f.client.command('openCheckout', { root });
    assert.equal(checkout.vcs, 'none');
    assert(!('branch' in checkout) && !('worktree' in checkout));
    assert.equal(checkout.root, root);
    // Its project is the folder itself, and reopening gives the same target.
    assert.deepEqual(await f.client.command('openCheckout', { root }), checkout);
    const repository = await f.client.command('openCheckout', { root: f.root });
    assert.notEqual(repository.projectId, checkout.projectId);

    // Files read, save and list as in a repository.
    const disk = await f.client.command('readFile', { checkout, path: 'todo.txt' });
    const saved = await f.client.command('saveFile', {
      target: { checkout, path: 'todo.txt' },
      clientId: 'folder-client',
      requestId: 'save-1',
      text: 'plan more',
      expectedVersion: disk.version,
    });
    assert.equal(saved.kind, 'saved');
    const listing = await f.client.command('listDirectory', { checkout, path: '' });
    assert.deepEqual(
      listing.entries.map((entry) => [entry.path, entry.ignored]),
      [
        ['drafts', false],
        ['todo.txt', false],
      ],
    );
    assert.equal(listing.error, undefined);
    assert.deepEqual(
      await f.client.command('getIgnoredPaths', { checkout, path: '', paths: ['todo.txt'] }),
      { paths: [] },
    );
    assert.deepEqual(
      (await f.client.command('lookupFiles', { checkout, query: 'todo' })).matches.map(
        (match) => match.path,
      ),
      ['todo.txt'],
    );

    // Callers that poll Git get empty results; Git changes are refused.
    assert.deepEqual(await f.client.command('gitStatus', { checkout }), {
      branch: '',
      changes: [],
    });
    assert.deepEqual(await f.client.command('listWorktrees', { checkout }), { worktrees: [] });
    await assert.rejects(
      f.client.command('readComparison', {
        target: { checkout, path: 'todo.txt' },
        area: 'unstaged',
      }),
      rejects('InvalidInput'),
    );
    await assert.rejects(
      f.client.command('createWorktree', {
        checkout,
        base: 'HEAD',
        branch: 'topic',
        location: join(f.base, 'topic'),
      }),
      rejects('InvalidInput'),
    );
    // A Git-shaped copy of the target is not the approved checkout.
    await assert.rejects(
      f.client.command('readFile', {
        checkout: { ...checkout, vcs: 'git', branch: 'main', worktree: 'main' },
        path: 'todo.txt',
      }),
      rejects('Unauthorized'),
    );

    // Watching needs no Git folder.
    let ready!: () => void;
    const isReady = new Promise<void>((resolve) => (ready = resolve));
    const changes: string[] = [];
    stop = f.client.watch(
      { checkout, paths: [''] },
      (event) => (event.ready ? ready() : changes.push(event.error ?? 'changed')),
      (error) => {
        throw error;
      },
    );
    await isReady;
    writeFileSync(join(root, 'drafts', 'new.txt'), 'new');
    const deadline = Date.now() + 5000;
    while (!changes.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(changes.slice(0, 1), ['changed']);
  } finally {
    await stop?.();
    await f.close();
  }
});

test('a folder inside a repository is still refused unless it is the checkout root', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'src'));
    await assert.rejects(
      f.client.command('openCheckout', { root: join(f.root, 'src') }),
      (error: unknown) =>
        rejects('InvalidInput')(error) &&
        (error as Error).message === 'Choose the repository checkout root.',
    );
  } finally {
    await f.close();
  }
});

test('initializeRepository turns a plain folder into a Git checkout without committing', async () => {
  const f = fixture();
  try {
    const root = folder(f);
    const plain = await f.client.command('openCheckout', { root });
    const repository = await f.client.command('openCheckout', { root: f.root });
    await assert.rejects(
      f.client.command('initializeRepository', { checkout: repository }),
      rejects('InvalidInput'),
    );
    assert(!existsSync(join(root, '.git')));

    const initialized = await f.client.command('initializeRepository', { checkout: plain });
    assert.equal(initialized.vcs, 'git');
    assert.equal(initialized.worktree, 'main');
    assert.equal(initialized.branch, git(root, 'symbolic-ref', '--short', 'HEAD'));
    // The same folder keeps its checkout identity; its project is now the repository.
    assert.equal(initialized.checkoutId, plain.checkoutId);
    assert.equal(initialized.root, root);
    assert.notEqual(initialized.projectId, plain.projectId);
    assert.throws(() => git(root, 'rev-parse', '--verify', '--quiet', 'HEAD'));

    // The Git target replaces the folder's approval.
    await assert.rejects(
      f.client.command('readFile', { checkout: plain, path: 'todo.txt' }),
      rejects('Unauthorized'),
    );
    await assert.rejects(
      f.client.command('initializeRepository', { checkout: plain }),
      rejects('Unauthorized'),
    );
    await assert.rejects(
      f.client.command('initializeRepository', { checkout: initialized }),
      rejects('InvalidInput'),
    );
    const status = await f.client.command('gitStatus', { checkout: initialized });
    assert.equal(status.branch, initialized.branch);
    assert.deepEqual(status.changes, [{ path: 'todo.txt', area: 'untracked' }]);

    // Reopening, here and after a restart, gives the Git target rather than refusing it.
    assert.deepEqual(await f.client.command('openCheckout', { root }), initialized);
    await f.runtime.dispose();
    const restarted = f.start();
    try {
      assert.deepEqual(await restarted.client.command('openCheckout', { root }), initialized);
    } finally {
      await restarted.runtime.dispose();
    }
  } finally {
    await f.close();
  }
});

test('a plain folder that became a repository outside Moonbase reopens as Git', async () => {
  const f = fixture();
  try {
    const root = folder(f);
    const plain: CheckoutTarget = await f.client.command('openCheckout', { root });
    git(root, 'init', '-q', '-b', 'trunk');
    const reopened = await f.client.command('openCheckout', { root });
    assert.equal(reopened.vcs === 'git' && reopened.branch, 'trunk');
    assert.equal(reopened.checkoutId, plain.checkoutId);
  } finally {
    await f.close();
  }
});
