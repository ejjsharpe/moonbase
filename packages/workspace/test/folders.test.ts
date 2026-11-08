import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ManagedRuntime } from 'effect';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { WorkspaceLive } from '../src/index.ts';
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
    writeFileSync(join(root, 'new.txt'), 'new');
    const deadline = Date.now() + 10_000;
    while (!changes.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(changes.slice(0, 1), ['changed']);
  } finally {
    await stop?.();
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
    assert.deepEqual(status.changes, [{ path: 'todo.txt', area: 'untracked', kind: 'untracked' }]);

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

test('a plain folder opens, and a folder inside a repository is refused, with a translated Git', async () => {
  const f = fixture();
  // Stands in for a localized Git: outside the C locale its messages are German.
  const git = join(f.base, 'translated-git');
  writeFileSync(
    git,
    [
      '#!/bin/sh',
      '[ "$LC_ALL" = C ] && exec /usr/bin/git "$@"',
      `err=${JSON.stringify(join(f.base, 'git-stderr'))}.$$`,
      '/usr/bin/git "$@" 2>"$err"; status=$?',
      'sed \'s/not a git repository/kein Git-Repository/\' "$err" >&2; rm -f "$err"',
      'exit $status',
      '',
    ].join('\n'),
  );
  chmodSync(git, 0o755);
  const locale = process.env.LC_ALL;
  process.env.LC_ALL = 'de_DE.UTF-8';
  const runtime = ManagedRuntime.make(
    WorkspaceLive({
      dataDirectory: join(f.base, 'translated-state'),
      hostId: 'local-test',
      gitExecutable: git,
    }),
  );
  const client = makeEditorClient(runtime);
  try {
    const root = folder(f);
    // In the user's locale the English text a locale-dependent check expects is gone.
    assert.match(
      spawnSync(git, ['-C', root, 'rev-parse', '--git-dir']).stderr.toString(),
      /kein Git-Repository/,
    );
    assert.equal((await client.command('openCheckout', { root })).vcs, 'none');
    mkdirSync(join(f.root, 'src'));
    await assert.rejects(
      client.command('openCheckout', { root: join(f.root, 'src') }),
      (error: unknown) =>
        rejects('InvalidInput')(error) &&
        (error as Error).message === 'Choose the repository checkout root.',
    );
  } finally {
    if (locale === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = locale;
    await runtime.dispose();
    await f.close();
  }
});

test('initializeRepository refuses a folder that already has a .git entry', async () => {
  const f = fixture();
  try {
    const root = folder(f);
    const plain = await f.client.command('openCheckout', { root });
    const pointer = `gitdir: ${join(f.root, '.git')}\n`;
    writeFileSync(join(root, '.git'), pointer);
    await assert.rejects(
      f.client.command('initializeRepository', { checkout: plain }),
      rejects('Conflict'),
    );
    assert.equal(readFileSync(join(root, '.git'), 'utf8'), pointer);
    // The folder's approval is unchanged.
    assert.equal(
      (await f.client.command('readFile', { checkout: plain, path: 'todo.txt' })).text,
      'plan',
    );
  } finally {
    await f.close();
  }
});

test('a plain folder whose .git now points at another repository does not reopen as Git', async () => {
  const f = fixture();
  try {
    const root = folder(f);
    const plain = await f.client.command('openCheckout', { root });
    // Git reads this as the other repository's main working tree, at this folder.
    writeFileSync(join(root, '.git'), `gitdir: ${join(f.root, '.git')}\n`);
    assert.equal(git(root, 'rev-parse', '--show-toplevel'), root);
    await assert.rejects(
      f.client.command('openCheckout', { root }),
      (error: unknown) =>
        rejects('InvalidInput')(error) &&
        /Checkout or repository identity changed/.test((error as Error).message),
    );
    // The folder's own approval still holds and nothing else was approved.
    await assert.rejects(
      f.client.command('initializeRepository', { checkout: plain }),
      rejects('Conflict'),
    );
  } finally {
    await f.close();
  }
});

test('initializeRepository waits for the folder’s file operations to settle', async () => {
  const f = fixture();
  try {
    const root = folder(f);
    const checkout = await f.client.command('openCheckout', { root });
    const created = await f.client.command('mutate', {
      id: 'create',
      clientId: 'alice',
      checkout,
      kind: 'create-file',
      sources: [],
      destination: 'created.txt',
      text: 'created',
    });
    assert.equal(created.outcome, 'completed');
    // Completed, but alice has not yet published and acknowledged it.
    await assert.rejects(
      f.client.command('initializeRepository', { checkout }),
      (error: unknown) =>
        rejects('InvalidInput')(error) && /file operation/.test((error as Error).message),
    );
    assert(!existsSync(join(root, '.git')));
    const current = await f.client.command('loadRecovery', { clientId: 'alice' });
    await f.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'alice',
      expectedRevision: current.revision,
      state: current.state,
    });
    await f.client.command('acknowledgeOperation', {
      clientId: 'alice',
      operationClientId: 'alice',
      id: 'create',
    });
    assert.equal((await f.client.command('initializeRepository', { checkout })).vcs, 'git');
  } finally {
    await f.close();
  }
});
