import { isAccessRefusal, isRefusal } from '@moonbase/contracts/error-groups';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  renameSync,
  symlinkSync,
  linkSync,
  chmodSync,
  mkdtempSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fixture } from './workspace-fixture.ts';
import { recordWatchDeliveries, startOnTestClock } from './watch-fixture.ts';

test('entries-only listings bypass Git ignore policy and leave classification unknown', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'visible.ts'), 'visible');
    writeFileSync(join(f.base, 'outside-ignore'), '*\n');
    symlinkSync(join(f.base, 'outside-ignore'), join(f.root, '.gitignore'));
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const listing = await f.client.command('listDirectory', {
      checkout,
      path: '',
      includeIgnoredStatus: false,
    });
    assert.equal(listing.partial, false);
    assert.equal(listing.error, undefined);
    assert.deepEqual(listing.entries, [{ path: 'visible.ts', directory: false }]);
    const ignored = await f.client.command('getIgnoredPaths', {
      checkout,
      path: '',
      paths: ['visible.ts'],
    });
    assert.match(ignored.error!, /Git ignore policy unavailable/);
    assert.deepEqual(ignored.paths, []);
    await assert.rejects(
      f.client.command('listDirectory', {
        checkout,
        path: '',
        includeIgnoredStatus: false,
        hideIgnored: true,
      }),
      isRefusal,
    );
  } finally {
    await f.close();
  }
});

test('ignore classification validates exact checkout and immediate child paths', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'src'));
    writeFileSync(join(f.root, '.gitignore'), 'hidden.ts\n');
    writeFileSync(join(f.root, 'src/hidden.ts'), 'hidden');
    writeFileSync(join(f.root, 'src/visible.ts'), 'visible');
    const checkout = await f.client.command('openCheckout', { root: f.root });
    assert.deepEqual(
      await f.client.command('getIgnoredPaths', {
        checkout,
        path: 'src',
        paths: ['src/hidden.ts', 'src/visible.ts'],
      }),
      { paths: ['src/hidden.ts'] },
    );
    for (const paths of [
      ['../outside'],
      ['.git/config'],
      ['src/nested/file.ts'],
      ['other/file.ts'],
    ])
      await assert.rejects(
        f.client.command('getIgnoredPaths', { checkout, path: 'src', paths }),
        isRefusal,
      );
    await assert.rejects(
      f.client.command('getIgnoredPaths', {
        checkout: { ...checkout, hostId: 'remote' },
        path: 'src',
        paths: ['src/hidden.ts'],
      }),
      isAccessRefusal,
    );
  } finally {
    await f.close();
  }
});

test('browsing a small folder does not scan unrelated project files', async (t) => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'src'));
    writeFileSync(join(f.root, 'src/visible.ts'), 'visible');
    writeFileSync(join(f.root, 'src/hidden.ts'), 'hidden');
    mkdirSync(join(f.root, 'src-fast'));
    writeFileSync(join(f.root, 'src-fast/visible.ts'), 'visible');
    writeFileSync(join(f.root, 'src-fast/hidden.ts'), 'hidden');
    writeFileSync(join(f.root, '.gitignore'), 'hidden.ts\n');
    mkdirSync(join(f.root, 'unrelated'));
    for (let index = 0; index < 20100; index++)
      writeFileSync(join(f.root, 'unrelated', `${index}.ts`), '');
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const fastStart = performance.now();
    const fast = await f.client.command('listDirectory', {
      checkout,
      path: 'src-fast',
      includeIgnoredStatus: false,
    });
    t.diagnostic(
      `First entries-only listing with 20,100 unrelated files: ${(performance.now() - fastStart).toFixed(1)} ms`,
    );
    assert.equal(fast.entries.length, 2);
    assert(fast.entries.every((entry) => entry.ignored === undefined));
    const start = performance.now();
    const listing = await f.client.command('listDirectory', {
      checkout,
      path: 'src',
      hideIgnored: true,
    });
    t.diagnostic(
      `Small-folder listing with 20,100 unrelated files: ${(performance.now() - start).toFixed(1)} ms`,
    );
    assert.equal(listing.partial, false, listing.error ?? 'Unexpected partial listing');
    assert.deepEqual(
      listing.entries.map((entry) => entry.path),
      ['src/visible.ts'],
    );
  } finally {
    await f.close();
  }
});

test('folder listings validate only applicable Git ignore policies and retain policy errors', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'src/deep'), { recursive: true });
    mkdirSync(join(f.root, 'unrelated'));
    writeFileSync(join(f.root, '.gitignore'), '*.log\nhidden.ts\n');
    writeFileSync(join(f.root, 'src/.gitignore'), '!hidden.ts\n');
    for (const name of ['visible.ts', 'hidden.ts', 'hidden.log'])
      writeFileSync(join(f.root, 'src/deep', name), name);
    writeFileSync(join(f.base, 'outside-ignore'), '*\n');
    symlinkSync(join(f.base, 'outside-ignore'), join(f.root, 'unrelated/.gitignore'));
    symlinkSync(join(f.base, 'outside-ignore'), join(f.root, '.ignore'));
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const list = () =>
      f.client.command('listDirectory', { checkout, path: 'src/deep', hideIgnored: true });
    const listing = await list();
    assert.equal(listing.partial, false, listing.error ?? 'Unexpected partial listing');
    assert.deepEqual(
      listing.entries.map((entry) => entry.path),
      ['src/deep/hidden.ts', 'src/deep/visible.ts'],
    );
    writeFileSync(join(f.root, 'src/deep/.gitignore'), 'hidden.ts\n');
    assert(!(await list()).entries.some((entry) => entry.path === 'src/deep/hidden.ts'));
    for (const policy of [
      'src/deep/.gitignore',
      'src/.gitignore',
      '.gitignore',
      '.git/info/exclude',
    ]) {
      const location = join(f.root, policy);
      const original = readFileSync(location);
      rmSync(location);
      symlinkSync(join(f.base, 'outside-ignore'), location);
      const unavailable = await list();
      assert.equal(unavailable.partial, true, policy);
      assert.match(unavailable.error!, /Git ignore policy unavailable/);
      assert.equal(
        unavailable.entries.filter((entry) => /\.(ts|log)$/.test(entry.path)).length,
        3,
        'Policy failure must show entries with an observable error',
      );
      rmSync(location);
      writeFileSync(location, original);
    }
  } finally {
    await f.close();
  }
});

test('local/remote and root replacement identities, traversal, symlinks, binary, size and hard-link save boundaries reject', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'file.txt'), 'disk');
    writeFileSync(join(f.base, 'secret'), 'secret');
    symlinkSync(join(f.base, 'secret'), join(f.root, 'link'));
    writeFileSync(join(f.root, 'binary'), Buffer.from([0, 12]));
    writeFileSync(join(f.root, 'large'), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
    const checkout = await f.client.command('openCheckout', { root: f.root });
    for (const p of [
      '../secret',
      '.git/config',
      'a/../file.txt',
      '/file.txt',
      'link',
      'binary',
      'large',
    ])
      await assert.rejects(f.client.command('readFile', { checkout, path: p }));
    await assert.rejects(
      f.client.command('readFile', {
        checkout: { ...checkout, hostId: 'remote' },
        path: 'file.txt',
      }),
      isAccessRefusal,
    );
    const disk = await f.client.command('readFile', { checkout, path: 'file.txt' });
    linkSync(join(f.root, 'file.txt'), join(f.root, 'hard-link'));
    await assert.rejects(
      f.client.command('saveFile', {
        target: { checkout, path: 'file.txt' },
        clientId: 'a',
        requestId: 'hard',
        text: 'new',
        expectedVersion: disk.version,
      }),
    );
    assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), 'disk');
    renameSync(f.root, f.root + '-old');
    mkdirSync(f.root);
    writeFileSync(join(f.root, 'file.txt'), 'wrong checkout');
    await assert.rejects(f.client.command('readFile', { checkout, path: 'file.txt' }));
  } finally {
    await f.close();
  }
});

test('Git staged and unstaged originals both compare against the current working document, lookup and ignore filtering work', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'file.txt'), 'HEAD');
    const git = (args: string[]) =>
      execFileSync('/usr/bin/git', [
        '-C',
        f.root,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        ...args,
      ]);
    git(['add', '.']);
    git(['commit', '-qm', 'initial']);
    writeFileSync(join(f.root, 'file.txt'), 'index');
    git(['add', '.']);
    writeFileSync(join(f.root, 'file.txt'), 'working');
    writeFileSync(join(f.root, '.gitignore'), 'ignored.txt\n');
    writeFileSync(join(f.root, 'ignored.txt'), 'ignored');
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const staged = await f.client.command('readComparison', {
        target: { checkout, path: 'file.txt' },
        area: 'staged',
      }),
      unstaged = await f.client.command('readComparison', {
        target: { checkout, path: 'file.txt' },
        area: 'unstaged',
      });
    assert.equal(staged.original, 'HEAD');
    assert.equal(unstaged.original, 'index');
    assert.equal(staged.working?.text, 'working');
    assert.deepEqual(
      (await f.client.command('gitStatus', { checkout })).changes
        .filter((c) => c.path === 'file.txt')
        .map((c) => [c.area, c.kind]),
      [
        ['staged', 'modified'],
        ['unstaged', 'modified'],
      ],
    );
    assert(
      (await f.client.command('lookupFiles', { checkout, query: 'fltx' })).matches.some(
        (match) => match.path === 'file.txt',
      ),
    );
    assert(
      !(
        await f.client.command('listDirectory', { checkout, path: '', hideIgnored: true })
      ).entries.some((e) => e.path === 'ignored.txt'),
    );
    rmSync(join(f.root, 'file.txt'));
    const deleted = await f.client.command('readComparison', {
      target: { checkout, path: 'file.txt' },
      area: 'unstaged',
    });
    assert.equal(deleted.original, 'index');
    assert.equal(deleted.working, null);
  } finally {
    await f.close();
  }
});

test('watch notifies external changes, coalesces and disposes independently of file commands', async () => {
  const f = fixture(),
    deliveries = recordWatchDeliveries(),
    { client, runtime, advance } = startOnTestClock(join(f.base, 'clocked-state'));
  const file = join(f.root, 'file.txt');
  // Writes the file until a watcher reported it, then closes the watches' windows.
  const change = async (text: string) => {
    await deliveries.write(file, text);
    await advance('100 millis');
  };
  const stops: (() => Promise<void>)[] = [];
  const watch = (receive: (event: { ready?: boolean }) => void) =>
    new Promise<void>((ready) => {
      stops.push(
        client.watch(
          { checkout, paths: [''] },
          (event) => {
            receive(event);
            if (event.ready) ready();
          },
          (error) => {
            throw error;
          },
        ),
      );
    });
  let checkout!: Awaited<ReturnType<typeof client.command<'openCheckout'>>>;
  try {
    writeFileSync(file, 'before');
    checkout = await client.command('openCheckout', { root: f.root });
    let count = 0;
    await watch(() => count++);
    await change('external');
    assert.equal(count, 2);
    await stops[0]();
    // A second watch shows the next change is reported, and closes its window with the first's.
    let probed = 0;
    await watch((event) => {
      if (!event.ready) probed++;
    });
    await change('after disposal');
    assert.equal(probed, 1);
    assert.equal(count, 2);
    assert.equal(
      (await client.command('readFile', { checkout, path: 'file.txt' })).text,
      'after disposal',
    );
  } finally {
    for (const stop of stops) await stop();
    deliveries.restore();
    await runtime.dispose();
    await f.close();
  }
});

test('watch skips activity that belongs to other worktrees of the repository', async () => {
  const f = fixture(),
    deliveries = recordWatchDeliveries(),
    { client, runtime, advance } = startOnTestClock(join(f.base, 'clocked-state'));
  const stops: (() => Promise<void>)[] = [];
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('/usr/bin/git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args]);
  // Once a barrier in the shared Git folder reached the main watch and the linked one's Git folder
  // watch, every earlier change is in their windows; closing the windows then publishes or skips
  // each of them.
  const settle = async () => {
    await deliveries.barrier(join(f.root, '.git'), 2);
    await advance('100 millis');
  };
  try {
    writeFileSync(join(f.root, 'file.txt'), 'main');
    writeFileSync(join(f.root, '.gitignore'), '.agents/\n');
    git(f.root, 'add', '.');
    git(f.root, 'commit', '-qm', 'initial');
    // An agent's worktree inside an ignored folder of the main checkout, plus one beside it.
    const nested = join(f.root, '.agents', 'nested'),
      beside = join(f.base, 'beside');
    git(f.root, 'worktree', 'add', '-q', '-b', 'nested', nested);
    git(f.root, 'worktree', 'add', '-q', '-b', 'beside', beside);
    const watchEvents = async (root: string) => {
      const checkout = await client.command('openCheckout', { root });
      const events: string[] = [];
      let ready!: () => void;
      const isReady = new Promise<void>((r) => (ready = r));
      stops.push(
        client.watch(
          { checkout, paths: [''] },
          (event) => (event.ready ? ready() : events.push(event.error ?? 'changed')),
          (error) => {
            throw error;
          },
        ),
      );
      await isReady;
      return events;
    };
    const main = await watchEvents(f.root),
      linked = await watchEvents(beside);
    await settle();
    main.length = linked.length = 0;

    // Files and Git activity in the nested worktree reach neither of the other checkouts.
    writeFileSync(join(nested, 'file.txt'), 'agent edit');
    writeFileSync(join(nested, 'new.txt'), 'agent file');
    git(nested, 'add', '.');
    git(nested, 'status', '--short');
    await settle();
    assert.deepEqual(main, [], 'A nested worktree must not refresh the main checkout');
    // Staging in the main checkout refreshes it, but not the linked worktree.
    writeFileSync(join(f.root, 'staged.txt'), 'staged');
    git(f.root, 'add', 'staged.txt');
    await settle();
    assert(main.length > 0);
    assert.deepEqual(linked, [], "Other worktrees' files and indexes must not refresh it");

    // Their own files still refresh them.
    main.length = 0;
    writeFileSync(join(beside, 'file.txt'), 'own edit');
    writeFileSync(join(f.root, 'file.txt'), 'own edit');
    await settle();
    assert.equal(linked.length, 1);
    assert.equal(main.length, 1);
    // Another worktree's commit moves a shared branch ref, which both still see.
    main.length = linked.length = 0;
    git(nested, 'commit', '-qm', 'agent commit');
    await settle();
    assert(main.length > 0 && linked.length > 0, 'A new commit moves a shared ref');
  } finally {
    for (const stop of stops) await stop();
    deliveries.restore();
    await runtime.dispose();
    await f.close();
  }
});

test('text search honours ignore policies, options, context lines and UTF-16 ranges', async () => {
  const f = fixture();
  try {
    for (const p of ['src', 'node_modules']) mkdirSync(join(f.root, p));
    writeFileSync(
      join(f.root, 'src/view.ts'),
      'one\ntwo\nconst é = followEnd(); // followEnd\nfour\nfive\nsix\nFollowEnd\n',
    );
    writeFileSync(join(f.root, 'src/followEnder.ts'), 'followEnder\n');
    writeFileSync(join(f.root, 'node_modules/dep.ts'), 'followEnd\n');
    writeFileSync(join(f.root, 'ignored.ts'), 'followEnd\n');
    writeFileSync(join(f.root, '.gitignore'), 'ignored.ts\n');
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const search = (
      query: string,
      options: Partial<Record<'matchCase' | 'wholeWord' | 'regex', boolean>> = {},
    ) =>
      f.client.command('searchText', {
        checkout,
        query,
        matchCase: false,
        wholeWord: false,
        regex: false,
        ...options,
      });
    const all = await search('followEnd');
    assert(!all.partial, all.error ?? 'Unexpected partial search');
    assert.deepEqual(
      all.files.map((file) => [file.path, file.matches.map((match) => match.line)]),
      [
        ['src/followEnder.ts', [1]],
        ['src/view.ts', [3, 7]],
      ],
    );
    const [line] = all.files[1].matches;
    assert.equal(line.text, 'const é = followEnd(); // followEnd');
    assert.deepEqual(
      line.ranges.map((range) => line.text.slice(range.start, range.end)),
      ['followEnd', 'followEnd'],
    );
    assert.deepEqual(line.before, ['one', 'two']);
    assert.deepEqual(line.after, ['four', 'five', 'six']);
    assert.deepEqual(
      (await search('followEnd', { matchCase: true })).files[1].matches.map((m) => m.line),
      [3],
    );
    assert.deepEqual(
      (await search('followEnd', { wholeWord: true })).files.map((file) => file.path),
      ['src/view.ts'],
    );
    assert.equal((await search('follow.nd(')).files.length, 0);
    assert.equal((await search('follow.nd\\(', { regex: true })).files[0].path, 'src/view.ts');
    await assert.rejects(search('(', { regex: true }), isRefusal);
    // Every pattern ripgrep reports it cannot compile is invalid input; its reason stays on the host.
    for (const pattern of ['(?<=x)y', 'a\\nb'])
      await assert.rejects(
        search(pattern, { regex: true }),
        (error) => isRefusal(error) && (error as { _tag?: string })._tag === 'InvalidPatternError',
      );
    // Past 50 matches a file is capped and reported partial, whether its matches are adjacent
    // (ripgrep keeps reporting matches inside trailing context) or spread out.
    writeFileSync(join(f.root, 'src/many.ts'), 'manyMatch\n'.repeat(60));
    writeFileSync(join(f.root, 'src/spread.ts'), 'spreadMatch\nx\nx\nx\nx\n'.repeat(60));
    for (const query of ['manyMatch', 'spreadMatch']) {
      const many = await search(query);
      assert.equal(many.partial, true, query);
      assert.equal(many.files[0].matches.length, 50, query);
    }
    // A query that looks like a flag is still the pattern.
    writeFileSync(join(f.root, 'src/flags.ts'), 'run --files here\n');
    assert.deepEqual(
      (await search('--files')).files.map((file) => file.path),
      ['src/flags.ts'],
    );
    // An unreadable file is reported without marking the other results partial.
    writeFileSync(join(f.root, 'src/locked.ts'), 'followEnd\n');
    chmodSync(join(f.root, 'src/locked.ts'), 0);
    try {
      const locked = await search('followEnd');
      assert.equal(locked.partial, false);
      assert.match(locked.error ?? '', /Some files could not be searched/);
      assert.deepEqual(
        locked.files.map((file) => file.path),
        ['src/followEnder.ts', 'src/view.ts'],
      );
    } finally {
      chmodSync(join(f.root, 'src/locked.ts'), 0o644);
    }
  } finally {
    await f.close();
  }
});

test('a broad text search stops at the cap with a clean partial result', async () => {
  const f = fixture();
  try {
    // Far more than 16 MiB of ripgrep output if every file were searched to its own cap.
    const line = 'e'.repeat(1500) + '\n';
    for (let n = 0; n < 60; n++)
      writeFileSync(join(f.root, `file-${String(n).padStart(2, '0')}.txt`), line.repeat(60));
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const result = await f.client.command('searchText', {
      checkout,
      query: 'e',
      matchCase: false,
      wholeWord: false,
      regex: false,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.partial, true);
    assert.equal(
      result.files.reduce((total, file) => total + file.matches.length, 0),
      500,
    );
    assert.deepEqual(
      result.files.map((file) => file.path),
      Array.from({ length: 10 }, (_, n) => `file-${String(n).padStart(2, '0')}.txt`),
    );
    // The last match kept still has its trailing context.
    assert.equal(result.files.at(-1)!.matches.at(-1)!.after.length, 3);
  } finally {
    await f.close();
  }
});

// Reports a match, then a line past the output limit, and exits 1 with nothing on stderr when
// the stop's SIGTERM arrives, as "no matches" would.
const stoppedRipgrep = `#!/bin/sh
trap 'exit 1' TERM
printf '%s\\n' '{"type":"match","data":{"path":{"text":"found.txt"},"lines":{"text":"e\\n"},"line_number":1,"submatches":[]}}'
head -c 17000000 /dev/zero | tr '\\0' e
sleep 60 & wait
`;

// Killed by a signal from elsewhere before it reports anything.
const killedRipgrep = `#!/bin/sh
kill -KILL $$
`;

test('a text search stopped at its limit reports itself partial however ripgrep exits, and a killed one fails', async () => {
  const base = mkdtempSync(join(tmpdir(), 'moonbase-ripgrep-'));
  const search = async (script: string) => {
    const ripgrep = join(base, 'rg');
    writeFileSync(ripgrep, script, { mode: 0o700 });
    const f = fixture({ ripgrepExecutable: ripgrep });
    try {
      const checkout = await f.client.command('openCheckout', { root: f.root });
      return await f.client.command('searchText', {
        checkout,
        query: 'e',
        matchCase: false,
        wholeWord: false,
        regex: false,
      });
    } finally {
      await f.close();
    }
  };
  try {
    const result = await search(stoppedRipgrep);
    assert.equal(result.partial, true);
    assert.match(result.error ?? '', /time or output limit/);
    assert.deepEqual(
      result.files.map((file) => file.path),
      ['found.txt'],
    );
    // A signal from elsewhere is no limit: the search fails rather than asking for a narrower query.
    await assert.rejects(search(killedRipgrep), { _tag: 'WorkspaceUnavailableError' });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('lookup honors nested ignore policies, ranks and highlights all pieces, quotes contiguous text, and keeps history separate', async () => {
  const f = fixture();
  try {
    for (const p of ['src', 'nested', 'node_modules']) mkdirSync(join(f.root, p));
    const files = [
      'src/FooBar.test.ts',
      'src/foo-baz.ts',
      'nested/hidden.ts',
      'nested/keep.ts',
      'node_modules/dep.ts',
      'ignored.ts',
      'rg-hidden.ts',
    ];
    files.forEach((p) => writeFileSync(join(f.root, p), p));
    writeFileSync(join(f.root, '.gitignore'), 'ignored.ts\n');
    writeFileSync(join(f.root, '.ignore'), 'rg-hidden.ts\n');
    writeFileSync(join(f.root, 'nested/.rgignore'), 'hidden.ts\n');
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const all = await f.client.command('lookupFiles', { checkout, query: 'ts' });
    assert(!all.partial, all.error ?? 'Unexpected partial discovery');
    assert(all.matches.some((m) => m.path === 'nested/keep.ts'));
    for (const hidden of ['nested/hidden.ts', 'node_modules/dep.ts', 'ignored.ts', 'rg-hidden.ts'])
      assert(!all.matches.some((m) => m.path === hidden));
    const pieces = await f.client.command('lookupFiles', { checkout, query: 'FB ts' });
    assert.equal(pieces.matches[0].path, 'src/FooBar.test.ts');
    assert.deepEqual(
      pieces.matches[0].positions.map((p) => pieces.matches[0].path[p]).join(''),
      'FBts',
    );
    assert.equal(
      (await f.client.command('lookupFiles', { checkout, query: 'FB nonexistent' })).matches.length,
      0,
    );
    assert.equal(
      (await f.client.command('lookupFiles', { checkout, query: '"FooBar"' })).matches[0].path,
      'src/FooBar.test.ts',
    );
    assert.equal(
      (await f.client.command('lookupFiles', { checkout, query: '"FB"' })).matches.length,
      0,
    );
    const history = [
      'node_modules/dep.ts',
      'missing.ts',
      'node_modules/dep.ts',
      'src/FooBar.test.ts',
    ];
    const recent = await f.client.command('lookupFiles', { checkout, query: 'ts', history });
    assert.equal(recent.history.filter((m) => m.path === 'node_modules/dep.ts').length, 1);
    assert(recent.history.some((m) => m.path === 'missing.ts'));
    assert(!recent.matches.some((m) => history.includes(m.path)));
    assert.equal(
      (await f.client.command('lookupFiles', { checkout, query: '', history })).matches.length,
      0,
    );
    assert.equal(
      (await f.client.command('lookupFiles', { checkout, query: 'node_modules/dep.ts' })).matches[0]
        .path,
      'node_modules/dep.ts',
    );
    assert((await f.client.command('lookupFiles', { checkout, query: 'ts', limit: 1 })).partial);
    await assert.rejects(
      f.client.command('lookupFiles', { checkout, query: 'ts', history: ['../outside'] }),
      isRefusal,
    );
    writeFileSync(join(f.base, 'outside-ignore'), '*\n');
    rmSync(join(f.root, '.ignore'));
    symlinkSync(join(f.base, 'outside-ignore'), join(f.root, '.ignore'));
    const unavailable = await f.client.command('lookupFiles', { checkout, query: 'ts' });
    assert(unavailable.partial && unavailable.error);
    assert.equal(unavailable.matches.length, 0);
  } finally {
    await f.close();
  }
});

test('unsubscribe during pending workspace/watch acquisition and concurrent runtime disposal release all native watchers', async () => {
  const f = fixture(),
    deliveries = recordWatchDeliveries();
  try {
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const before = process.getActiveResourcesInfo().filter((name) => name === 'FSEventWrap').length;
    let delivered = 0;
    const errors: unknown[] = [];
    const stops = Array.from({ length: 16 }, () =>
      f.client.watch(
        { checkout, paths: [''] },
        () => delivered++,
        (error) => errors.push(error),
      ),
    );
    await Promise.all(stops.map((stop) => stop()));
    await f.runtime.dispose();
    // Every native watcher is closed, so nothing can be delivered later.
    assert.equal(deliveries.open(), 0);
    assert.equal(delivered, 0);
    assert.equal(errors.length, 0);
    assert.equal(
      process.getActiveResourcesInfo().filter((name) => name === 'FSEventWrap').length,
      before,
    );
  } finally {
    deliveries.restore();
    await f.close();
  }
});

test('the host caps open watches and frees a slot when a watch closes', async () => {
  const f = fixture();
  const stops: (() => Promise<void>)[] = [];
  const watch = () =>
    new Promise<unknown>((settle) => {
      stops.push(
        f.client.watch(
          { checkout, paths: [''] },
          (event) => event.ready && settle(undefined),
          settle,
        ),
      );
    });
  const isWatchLimit = (error: unknown) =>
    (error as { problem?: unknown } | undefined)?.problem === 'watch-limit';
  let checkout!: Awaited<ReturnType<typeof f.client.command<'openCheckout'>>>;
  try {
    checkout = await f.client.command('openCheckout', { root: f.root });
    const opened = await Promise.all(Array.from({ length: 64 }, watch));
    assert(opened.every((outcome) => outcome === undefined));
    assert(isWatchLimit(await watch()));
    await stops[0]();
    assert.equal(await watch(), undefined);
  } finally {
    for (const stop of stops) await stop().catch(() => {});
    await f.close();
  }
});

test('native assets in packaged resource paths run with restricted PATH and no provider startup dependency', async () => {
  const { fileURLToPath } = await import('node:url'),
    { copyFileSync } = await import('node:fs');
  const f = fixture();
  try {
    const resources = join(f.base, 'Packaged Resources');
    mkdirSync(resources);
    const filesystem = join(resources, 'filesystem'),
      rg = join(resources, 'ripgrep');
    copyFileSync(fileURLToPath(new URL('../dist/filesystem', import.meta.url)), filesystem);
    chmodSync(filesystem, 0o700);
    const installed =
      process.env.MOONBASE_TEST_RIPGREP ??
      execFileSync('/bin/sh', ['-c', 'command -v rg'], { encoding: 'utf8' }).trim();
    copyFileSync(installed, rg);
    chmodSync(rg, 0o700);
    writeFileSync(join(f.root, 'file.txt'), 'disk');
    const output = execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        fileURLToPath(new URL('./packaged-assets-process.ts', import.meta.url)),
        f.root,
        f.dataDirectory,
        filesystem,
        rg,
      ],
      { env: { ...process.env, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10000 },
    );
    assert(output.includes('Independent workspace assets passed'));
    assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), 'saved from isolated assets');
  } finally {
    await f.close();
  }
});

test('the file host opens only on exactly Bun 1.4.4', async () => {
  const original = Object.getOwnPropertyDescriptor(process, 'versions')!;
  const f = fixture();
  Object.defineProperty(process, 'versions', {
    ...original,
    value: { ...process.versions, bun: '1.4.5' },
  });
  try {
    await assert.rejects(f.client.command('openCheckout', { root: f.root }), {
      _tag: 'WorkspaceUnsupportedError',
      feature: 'runtime',
    });
  } finally {
    Object.defineProperty(process, 'versions', original);
    await f.close();
  }
});
